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
import { BinanceAccountProvider, StaticPortfolioStateProvider } from "./core/account-state";
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
import type {
  AccountStateProvider,
  MarketDataQuery,
  OutputFormat,
  PipelineMode,
  RunnerState,
  TelemetrySink
} from "./types";
import { printRunReport } from "./utils/report";

export interface AppRunOverrides {
  mode?: PipelineMode;
  outputFormat?: OutputFormat;
  showTelemetry?: boolean;
  telemetryConsoleMirror?: boolean;
  runnerEnabled?: boolean;
  runnerIntervalSeconds?: number;
  runnerCandleAlign?: boolean;
  runnerMaxBackoffSeconds?: number;
  query?: Partial<MarketDataQuery>;
}

const modeFromEnv = (): PipelineMode =>
  (process.env.PIPELINE_MODE as PipelineMode | undefined) ?? "backtest";

const outputFormatFromEnv = (): OutputFormat =>
  (process.env.OUTPUT_FORMAT as OutputFormat | undefined) ?? "pretty";

const boolEnv = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
};

export const runApp = async (overrides: AppRunOverrides = {}): Promise<void> => {
  const runtime = loadRuntimeConfig();

  const mode = overrides.mode ?? modeFromEnv();
  const outputFormat = overrides.outputFormat ?? outputFormatFromEnv();
  const showTelemetry = overrides.showTelemetry ?? boolEnv("SHOW_TELEMETRY", false);
  const telemetryConsoleMirror =
    overrides.telemetryConsoleMirror ?? boolEnv("TELEMETRY_CONSOLE", false);
  const runnerEnabled = overrides.runnerEnabled ?? runtime.runnerEnabled;
  const runnerIntervalSeconds =
    overrides.runnerIntervalSeconds ?? runtime.runnerIntervalSeconds;
  const runnerCandleAlign = overrides.runnerCandleAlign ?? runtime.runnerCandleAlign;
  const runnerMaxBackoffSeconds =
    overrides.runnerMaxBackoffSeconds ?? runtime.runnerMaxBackoffSeconds;

  const query: MarketDataQuery = {
    asset: overrides.query?.asset ?? "SOL/USDT",
    timeframe: overrides.query?.timeframe ?? "1h",
    limit: Math.max(1, overrides.query?.limit ?? 50),
    since: overrides.query?.since
  };

  const memorySink = new InMemoryTelemetrySink(telemetryConsoleMirror);
  const sqliteSink = runtime.obsPersistEnabled
    ? new SqliteTelemetrySink(runtime.obsSqlitePath)
    : null;
  const sink: TelemetrySink = sqliteSink
    ? new FanoutTelemetrySink([memorySink, sqliteSink])
    : memorySink;

  const eventPersistence = runtime.obsPersistEnabled
    ? new SqliteEventStorePersistence(runtime.obsSqlitePath)
    : undefined;
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

  const staticPortfolioProvider = new StaticPortfolioStateProvider({
    equityUsd: 50,
    currentExposurePct: runtime.binanceDefaultExposurePct,
    currentDrawdownPct: runtime.binanceDefaultDrawdownPct,
    liquidityUsd: 1400000
  });

  const accountStateProvider: AccountStateProvider =
    runtime.binanceAccountEnabled && mode !== "backtest"
      ? new BinanceAccountProvider({
          enabled: true,
          failHard: true,
          apiKey: runtime.binanceApiKey,
          apiSecret: runtime.binanceApiSecret,
          accountScope: runtime.binanceAccountScope,
          defaultExposurePct: runtime.binanceDefaultExposurePct,
          defaultDrawdownPct: runtime.binanceDefaultDrawdownPct,
          telemetrySink: sink,
          healthMonitor,
          mode,
          timeoutMs: runtime.nodeTimeoutMs
        })
      : staticPortfolioProvider;

  const marketDataProvider = createModeDataProvider(mode, {
    strictRealMode: runtime.strictRealMode,
    theNewsApiKey: runtime.theNewsApiKey,
    coinGeckoApiKey: runtime.coinGeckoApiKey,
    theNewsApiBaseUrl: runtime.theNewsApiBaseUrl,
    alternativeMeBaseUrl: runtime.alternativeMeBaseUrl,
    coinGeckoBaseUrl: runtime.coinGeckoBaseUrl,
    providerCacheTtlSeconds: runtime.providerCacheTtlSeconds,
    traceId: "trace-bootstrap",
    runId: "run-bootstrap",
    mode,
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
    mode,
    contextFactory: (input, trace) => ({
      runId: input.runId,
      traceId: trace,
      mode: input.mode ?? mode,
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
      mode,
      query,
      result,
      outputFormat
    });

    if (showTelemetry) {
      console.log("--- Telemetry ---");
      console.log(
        JSON.stringify(
          {
            metrics: memorySink.getMetrics(),
            alerts: memorySink.getAlerts(),
            logs: memorySink.getLogs()
          },
          null,
          2
        )
      );

      if (sqliteSink) {
        console.log("--- Persisted Recent Runs ---");
        console.log(JSON.stringify(sqliteSink.getRecentRuns(10), null, 2));
      }

      console.log("--- Health Snapshot ---");
      console.log(
        JSON.stringify(healthMonitor.getSnapshot(() => new Date().toISOString()), null, 2)
      );

      const accountSnapshot = accountStateProvider.getLastSnapshot();
      if (accountSnapshot) {
        console.log("--- Binance Account Snapshot ---");
        console.log(JSON.stringify(accountSnapshot, null, 2));
      }
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
        mode,
        asset: query.asset,
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
        mode,
        asset: query.asset,
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
        mode,
        asset: query.asset,
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
        mode,
        asset: query.asset,
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
      tags: { mode, node: "Retention", source: "system" },
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
    if (runnerEnabled) {
      const runner = new RunnerService({
        config: {
          enabled: runnerEnabled,
          intervalSeconds: runnerIntervalSeconds,
          candleAlign: runnerCandleAlign,
          maxBackoffSeconds: runnerMaxBackoffSeconds,
          query,
          portfolio: await accountStateProvider.getPortfolioState({
            runId: "run-bootstrap",
            traceId: "trace-bootstrap",
            mode,
            asset: query.asset
          })
        },
        mode,
        outputFormat,
        pipeline,
        runInputFactory: async (runId, traceId, currentMode) => ({
          runId,
          traceId,
          mode: currentMode,
          query,
          portfolio: await accountStateProvider.getPortfolioState({
            runId,
            traceId,
            mode: currentMode,
            asset: query.asset
          })
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
              mode,
              asset: query.asset,
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
    const portfolio = await accountStateProvider.getPortfolioState({
      runId,
      traceId,
      mode,
      asset: query.asset
    });
    const result = await pipeline.runCycle({
      runId,
      traceId,
      mode,
      query,
      portfolio
    });

    await printCycle(result);
  } finally {
    await healthServer.stop();
  }
};

const isDirectRun = process.argv[1]?.includes("main");
if (isDirectRun) {
  runApp().catch((error) => {
    console.error("Pipeline execution failed", error);
    process.exitCode = 1;
  });
}
