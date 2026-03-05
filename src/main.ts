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
import { InMemoryEventStore } from "./core/event-store";
import { HealthMonitor } from "./core/health";
import { LLMRunner } from "./core/llm-runner";
import { TradingPipeline, createModeDataProvider } from "./core/pipeline";
import { InMemoryTelemetrySink } from "./core/telemetry";
import { SimulatedExchange } from "./sim/simulated-exchange";
import type { OutputFormat, PipelineMode } from "./types";
import { printRunReport } from "./utils/report";

const modeFromEnv = (process.env.PIPELINE_MODE as PipelineMode | undefined) ?? "backtest";
const outputFormatFromEnv = (process.env.OUTPUT_FORMAT as OutputFormat | undefined) ?? "pretty";
const showTelemetry = (process.env.SHOW_TELEMETRY ?? "false").toLowerCase() === "true";
const telemetryConsoleMirror = (process.env.TELEMETRY_CONSOLE ?? "false").toLowerCase() === "true";

const createDeterministicClock = (startIso: string) => {
  let tick = 0;
  const baseMs = new Date(startIso).getTime();
  return () => new Date(baseMs + tick++ * 1000).toISOString();
};

const run = async (): Promise<void> => {
  const runtime = loadRuntimeConfig();
  const eventStore = new InMemoryEventStore();
  const telemetrySink = new InMemoryTelemetrySink(telemetryConsoleMirror);
  const healthMonitor = new HealthMonitor(telemetrySink, {
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
    telemetrySink,
    healthMonitor
  });

  const runRequest = {
    runId: "run-main-001",
    traceId: randomUUID(),
    mode: modeFromEnv,
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

  const pipeline = new TradingPipeline({
    eventStore,
    telemetrySink,
    healthMonitor,
    marketDataProvider: createModeDataProvider(modeFromEnv, {
      strictRealMode: runtime.strictRealMode,
      theNewsApiKey: runtime.theNewsApiKey,
      coinGeckoApiKey: runtime.coinGeckoApiKey,
      theNewsApiBaseUrl: runtime.theNewsApiBaseUrl,
      alternativeMeBaseUrl: runtime.alternativeMeBaseUrl,
      coinGeckoBaseUrl: runtime.coinGeckoBaseUrl,
      providerCacheTtlSeconds: runtime.providerCacheTtlSeconds,
      traceId: runRequest.traceId,
      runId: runRequest.runId,
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
    }),
    decisionRunner,
    riskRules: defaultRiskRules,
    llmMaxRetries: runtime.llmMaxRetries,
    runTimeoutMs: runtime.runTimeoutMs,
    nodeTimeoutMs: runtime.nodeTimeoutMs,
    mode: modeFromEnv,
    contextFactory: (input, traceId) => ({
      runId: input.runId,
      traceId,
      mode: input.mode ?? modeFromEnv,
      asset: input.query.asset,
      nowIso: createDeterministicClock("2026-03-05T00:00:00.000Z")
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
      simulatedExchange: new SimulatedExchange(eventStore)
    }
  });

  const result = await pipeline.runCycle(runRequest);

  printRunReport({
    runId: runRequest.runId,
    mode: modeFromEnv,
    query: runRequest.query,
    result,
    outputFormat: outputFormatFromEnv
  });

  if (showTelemetry) {
    console.log("--- Telemetry ---");
    console.log(JSON.stringify({
      metrics: telemetrySink.getMetrics(),
      alerts: telemetrySink.getAlerts(),
      logs: telemetrySink.getLogs()
    }, null, 2));
    console.log("--- Health Snapshot ---");
    console.log(JSON.stringify(healthMonitor.getSnapshot(() => new Date().toISOString()), null, 2));
  }
};

run().catch((error) => {
  console.error("Pipeline execution failed", error);
  process.exitCode = 1;
});


