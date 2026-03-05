import { randomUUID } from "node:crypto";
import {
  BearishResearcher,
  BullishResearcher,
  DebateSynthesizer,
  FundamentalsAnalyst,
  NewsAnalyst,
  PortfolioManager,
  RiskManager,
  SentimentAnalyst,
  TechnicalAnalyst,
  TraderAgent
} from "./agents";
import { defaultRiskRules } from "./config/risk";
import { loadRuntimeConfig } from "./core/env";
import { InMemoryEventStore, SqliteEventStorePersistence } from "./core/event-store";
import { HealthServer } from "./core/health-server";
import { HealthMonitor } from "./core/health";
import { LLMRunner } from "./core/llm-runner";
import type { PipelineRunResult } from "./core/pipeline";
import { TradingPipeline, createModeDataProvider } from "./core/pipeline";
import { RunnerService } from "./core/runner";
import { FanoutTelemetrySink, InMemoryTelemetrySink, SqliteTelemetrySink } from "./core/telemetry";
import { SimulatedExchange } from "./sim/simulated-exchange";
import type { OutputFormat, PipelineMode, RunnerState, TelemetrySink } from "./types";
import { printRunReport } from "./utils/report";

const modeFromEnv = (process.env.PIPELINE_MODE as PipelineMode | undefined) ?? "backtest";
const outputFormatFromEnv = (process.env.OUTPUT_FORMAT as OutputFormat | undefined) ?? "pretty";
const showTelemetry = (process.env.SHOW_TELEMETRY ?? "false").toLowerCase() === "true";
const telemetryConsoleMirror = (process.env.TELEMETRY_CONSOLE ?? "false").toLowerCase() === "true";

const run = async (): Promise<void> => {
  const runtime = loadRuntimeConfig();

  const memorySink = new InMemoryTelemetrySink(telemetryConsoleMirror);
  const sqliteSink = runtime.obsPersistEnabled ? new SqliteTelemetrySink(runtime.obsSqlitePath) : null;
  const sink: TelemetrySink = sqliteSink ? new FanoutTelemetrySink([memorySink, sqliteSink]) : memorySink;

  const eventPersistence = runtime.obsPersistEnabled ? new SqliteEventStorePersistence(runtime.obsSqlitePath) : undefined;
  const eventStore = new InMemoryEventStore(eventPersistence);

  const healthMonitor = new HealthMonitor(sink, {
    maxP95RunLatencyMs: runtime.sloP95RunLatencyMs,
    maxFallbackRatio: runtime.sloMaxFallbackRatio,
    maxConsecutiveFailures: runtime.sloMaxConsecutiveFailures
  });

  const decisionRunner = new LLMRunner({
    apiKey: runtime.openRouterApiKey,
    baseUrl: runtime.openRouterBaseUrl,
    model: runtime.openRouterModel,
    defaultMaxRetries: runtime.llmMaxRetries,
    timeoutMs: runtime.nodeTimeoutMs,
    telemetrySink: sink,
    healthMonitor
  });

  const baseRunInput = {
    query: {
      asset: "SOL/USDT",
      timeframe: "1h",
      limit: 50
    },
    portfolio: {
      equityUsd: 50,
      currentExposurePct: 8,
      currentDrawdownPct: 3,
      liquidityUsd: 1400000
    }
  };

  const marketDataProvider = createModeDataProvider(modeFromEnv, {
    strictRealMode: runtime.strictRealMode,
    theNewsApiKey: runtime.theNewsApiKey,
    coinGeckoApiKey: runtime.coinGeckoApiKey,
    theNewsApiBaseUrl: runtime.theNewsApiBaseUrl,
    alternativeMeBaseUrl: runtime.alternativeMeBaseUrl,
    coinGeckoBaseUrl: runtime.coinGeckoBaseUrl,
    providerCacheTtlSeconds: runtime.providerCacheTtlSeconds,
    traceId: "trace-bootstrap",
    runId: "run-bootstrap",
    mode: modeFromEnv,
    requestsPerSecond: runtime.externalRequestsPerSecond,
    timeoutMs: runtime.nodeTimeoutMs,
    retryPolicy: {
      maxAttempts: runtime.providerRetryMaxAttempts,
      initialDelayMs: runtime.providerRetryInitialDelayMs,
      backoffFactor: runtime.providerRetryBackoffFactor,
      maxDelayMs: runtime.providerRetryMaxDelayMs,
      jitterMs: runtime.providerRetryJitterMs
    }
  });

  const pipeline = new TradingPipeline({
    eventStore,
    telemetrySink: sink,
    healthMonitor,
    marketDataProvider,
    decisionRunner,
    riskRules: defaultRiskRules,
    llmMaxRetries: runtime.llmMaxRetries,
    runTimeoutMs: runtime.runTimeoutMs,
    nodeTimeoutMs: runtime.nodeTimeoutMs,
    mode: modeFromEnv,
    contextFactory: (input, trace) => ({
      runId: input.runId,
      traceId: trace,
      mode: input.mode ?? modeFromEnv,
      asset: input.query.asset,
      nowIso: () => new Date().toISOString()
    }),
    agents: {
      fundamentalsAnalyst: new FundamentalsAnalyst(eventStore),
      sentimentAnalyst: new SentimentAnalyst(eventStore),
      newsAnalyst: new NewsAnalyst(eventStore),
      technicalAnalyst: new TechnicalAnalyst(eventStore),
      bullishResearcher: new BullishResearcher(eventStore),
      bearishResearcher: new BearishResearcher(eventStore),
      debateSynthesizer: new DebateSynthesizer(eventStore),
      traderAgent: new TraderAgent(eventStore),
      riskManager: new RiskManager(eventStore),
      portfolioManager: new PortfolioManager(eventStore),
      simulatedExchange: new SimulatedExchange(eventStore, {
        feeBps: runtime.simFeeBps,
        slippageBps: runtime.simSlippageBps,
        partialFillEnabled: runtime.simPartialFillEnabled
      })
    }
  });

  const printCycle = async (result: PipelineRunResult): Promise<void> => {
    printRunReport({
      runId: result.logs[0]?.runId ?? "unknown",
      mode: modeFromEnv,
      query: baseRunInput.query,
      result,
      outputFormat: outputFormatFromEnv
    });

    if (showTelemetry) {
      console.log("--- Telemetry ---");
      console.log(JSON.stringify({
        metrics: memorySink.getMetrics(),
        alerts: memorySink.getAlerts(),
        logs: memorySink.getLogs()
      }, null, 2));

      if (sqliteSink) {
        console.log("--- Persisted Recent Runs ---");
        console.log(JSON.stringify(sqliteSink.getRecentRuns(10), null, 2));
      }

      console.log("--- Health Snapshot ---");
      console.log(JSON.stringify(healthMonitor.getSnapshot(() => new Date().toISOString()), null, 2));
    }
  };

  const emitRunnerCycleMetrics = async (
    runId: string,
    traceId: string,
    intervalSec: number,
    backoffLevel: number
  ): Promise<void> => {
    const nowIso = new Date().toISOString();
    await sink.emitMetric({
      name: "runner_cycle_interval_seconds",
      value: intervalSec,
      timestamp: nowIso,
      tags: {
        run_id: runId,
        trace_id: traceId,
        mode: modeFromEnv,
        asset: baseRunInput.query.asset,
        node: "Runner",
        source: "system",
        provider: ""
      }
    });
    await sink.emitMetric({
      name: "runner_backoff_level",
      value: backoffLevel,
      timestamp: nowIso,
      tags: {
        run_id: runId,
        trace_id: traceId,
        mode: modeFromEnv,
        asset: baseRunInput.query.asset,
        node: "Runner",
        source: "system",
        provider: ""
      }
    });
    await sink.emitMetric({
      name: "runner_state",
      value: backoffLevel > 0 ? 1 : 0,
      timestamp: nowIso,
      tags: {
        run_id: runId,
        trace_id: traceId,
        mode: modeFromEnv,
        asset: baseRunInput.query.asset,
        node: "Runner",
        source: "system",
        provider: "",
        state: backoffLevel > 0 ? "backoff" : "normal"
      }
    });
  };

  const emitRunnerHeartbeat = async (state: RunnerState): Promise<void> => {
    await sink.emitMetric({
      name: "runner_heartbeat",
      value: 1,
      timestamp: new Date().toISOString(),
      tags: {
        mode: modeFromEnv,
        asset: baseRunInput.query.asset,
        node: "Runner",
        source: "system",
        provider: "",
        state: state.backoffLevel > 0 ? "backoff" : "normal",
        interval_seconds: state.currentIntervalSeconds,
        backoff_level: state.backoffLevel
      }
    });
  };

  const runRetentionCleanup = async (): Promise<void> => {
    if (!sqliteSink || !runtime.obsCleanupEnabled) {
      return;
    }
    const cutoffMs = Date.now() - runtime.obsRetentionDays * 24 * 60 * 60 * 1000;
    const cutoffIso = new Date(cutoffMs).toISOString();
    const result = sqliteSink.purgeOlderThan(cutoffIso);
    await sink.emitLog({
      timestamp: new Date().toISOString(),
      level: "info",
      message: `observability retention cleanup cutoff=${cutoffIso}`,
      trace_id: "system",
      tags: { mode: modeFromEnv, node: "Retention", source: "system" },
      data: { ...result }
    });
  };

  await runRetentionCleanup();

  let runnerStateSnapshot: RunnerState | null = null;
  const healthServer = new HealthServer({
    config: {
      enabled: runtime.healthServerEnabled,
      port: runtime.healthServerPort
    },
    monitor: healthMonitor,
    getRunnerState: () => runnerStateSnapshot,
    getLastRun: () => healthMonitor.getLastRunSample()
  });
  await healthServer.start();
  try {
    if (runtime.runnerEnabled) {
      const runner = new RunnerService({
      config: {
        enabled: runtime.runnerEnabled,
        intervalSeconds: runtime.runnerIntervalSeconds,
        candleAlign: runtime.runnerCandleAlign,
        maxBackoffSeconds: runtime.runnerMaxBackoffSeconds,
        query: baseRunInput.query,
        portfolio: baseRunInput.portfolio
      },
      mode: modeFromEnv,
      outputFormat: outputFormatFromEnv,
      pipeline,
      runInputFactory: (runId, traceId, mode) => ({
        runId,
        traceId,
        mode,
        query: baseRunInput.query,
        portfolio: baseRunInput.portfolio
      }),
      onCycleResult: async (result, state) => {
        const runId = result.logs[0]?.runId ?? "";
        await emitRunnerCycleMetrics(
          runId,
          result.traceId,
          state.currentIntervalSeconds,
          state.backoffLevel
        );
        await runRetentionCleanup();
        await printCycle(result);
      },
      onCycleError: async (error, runId, traceId, state) => {
        await emitRunnerCycleMetrics(
          runId,
          traceId,
          state.currentIntervalSeconds,
          state.backoffLevel
        );
        await runRetentionCleanup();
        await sink.emitAlert({
          timestamp: new Date().toISOString(),
          name: "runner_cycle_failure",
          severity: "critical",
          trace_id: traceId,
          tags: {
            run_id: runId,
            trace_id: traceId,
            mode: modeFromEnv,
            asset: baseRunInput.query.asset,
            node: "Runner",
            source: "system",
            provider: ""
          },
          message: String(error)
        });
      },
      onState: async (state) => {
        runnerStateSnapshot = state;
        await emitRunnerHeartbeat(state);
      },
      getNewCriticalAlerts: (sinceIndex) => {
        const allAlerts = memorySink.getAlerts();
        const delta = allAlerts.slice(Math.max(0, sinceIndex));
        const critical = delta.filter((a) => a.severity === "critical");
        return { alerts: critical, nextIndex: allAlerts.length };
      }
    });

      console.log("Runner mode enabled: hybrid continuous cycle started.");
      await runner.start();
      return;
    }

    const runId = "run-main-001";
    const traceId = randomUUID();
    const result = await pipeline.runCycle({
      runId,
      traceId,
      mode: modeFromEnv,
      query: baseRunInput.query,
      portfolio: baseRunInput.portfolio
    });

    await printCycle(result);
  } finally {
    await healthServer.stop();
  }
};

run().catch((error) => {
  console.error("Pipeline execution failed", error);
  process.exitCode = 1;
});
