import assert from "node:assert/strict";
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
} from "../agents";
import { defaultRiskRules } from "../config/risk";
import { InMemoryEventStore } from "../core/event-store";
import { HealthMonitor } from "../core/health";
import { computeBackoffDelay } from "../core/ops";
import { InMemoryTelemetrySink } from "../core/telemetry";
import type { DecisionRunner } from "../core/llm-runner";
import { BacktestDataProvider, RealCryptoDataProvider } from "../core/market-data";
import { TradingPipeline } from "../core/pipeline";
import {
  debateOutputSchema,
  executionDecisionSchema,
  fundamentalsAnalysisSchema,
  newsAnalysisSchema,
  riskDecisionSchema,
  sentimentAnalysisSchema,
  technicalAnalysisSchema,
  tradeProposalSchema
} from "../core/schemas";
import { SimulatedExchange } from "../sim/simulated-exchange";
import { formatChatStyleRunReport, printRunReport } from "../utils/report";
import type { MarketDataQuery, OHLCVCandle, ProviderFetchResult } from "../types";
import { ProviderError } from "../types";

const makeClock = () => {
  let i = 0;
  const base = new Date("2026-03-05T12:00:00.000Z").getTime();
  return () => new Date(base + i++ * 1000).toISOString();
};

class MockDecisionRunner implements DecisionRunner {
  public constructor(
    private readonly mode: "llm" | "fallback" | "retry_fallback" | "unsafe_llm"
  ) {}

  public async runWithFallback<T>(args: {
    config: { nodeName: string; maxRetries: number };
    schema: { parse: (input: unknown) => T };
    systemPrompt: string;
    input: unknown;
    fallback: () => Promise<T>;
    trace?: { traceId: string; runId: string; mode: string; asset: string };
  }): Promise<{ output: T; source: "llm" | "fallback"; retries: number; decisionRationale: string }> {
    if (this.mode === "unsafe_llm" && args.config.nodeName === "RiskManager") {
      const output = args.schema.parse({
        output: {
          approved: true,
          adjusted_position_size_pct: 95,
          risk_score: 5,
          reasons: ["Mock unsafe approval"]
        },
        decision_rationale: "Mock unsafe risk"
      });
      return { output, source: "llm", retries: 0, decisionRationale: "mock" };
    }

    if (this.mode === "unsafe_llm" && args.config.nodeName === "PortfolioManager") {
      const output = args.schema.parse({
        output: {
          approve: true,
          capital_allocated: 99999999,
          execution_instructions: {
            type: "market",
            tif: "IOC",
            side: "buy",
            quantity_notional_usd: 99999999
          },
          reasons: ["Mock unsafe capital"]
        },
        decision_rationale: "Mock unsafe portfolio"
      });
      return { output, source: "llm", retries: 0, decisionRationale: "mock" };
    }

    const fallbackOutput = await args.fallback();

    if (this.mode === "llm") {
      return {
        output: fallbackOutput,
        source: "llm",
        retries: 0,
        decisionRationale: "mock llm"
      };
    }

    if (this.mode === "retry_fallback") {
      return {
        output: fallbackOutput,
        source: "fallback",
        retries: 2,
        decisionRationale: "mock retry then fallback"
      };
    }

    return {
      output: fallbackOutput,
      source: "fallback",
      retries: 0,
      decisionRationale: "mock fallback"
    };
  }
}

const buildPipeline = (runner: DecisionRunner) => {
  const eventStore = new InMemoryEventStore();
  const telemetrySink = new InMemoryTelemetrySink(false);
  const healthMonitor = new HealthMonitor(telemetrySink, {
    maxP95RunLatencyMs: 30000,
    maxFallbackRatio: 0.5,
    maxConsecutiveFailures: 2
  });

  const pipeline = new TradingPipeline({
    eventStore,
    telemetrySink,
    healthMonitor,
    marketDataProvider: new BacktestDataProvider(),
    decisionRunner: runner,
    riskRules: defaultRiskRules,
    llmMaxRetries: 2,
    runTimeoutMs: 30000,
    nodeTimeoutMs: 15000,
    contextFactory: (input, traceId) => ({ runId: input.runId, traceId, mode: input.mode ?? "backtest", asset: input.query.asset, nowIso: makeClock() }),
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

  return { pipeline, eventStore, telemetrySink, healthMonitor };
};

const runDeterministicChecks = async (): Promise<void> => {
  const { pipeline: fallbackPipeline } = buildPipeline(new MockDecisionRunner("fallback"));
  const fallbackRun = await fallbackPipeline.runCycle({
    runId: "validate-fallback",
    query: { asset: "BTC/USDT", timeframe: "1h", limit: 50 },
    portfolio: { equityUsd: 100000, currentExposurePct: 10, currentDrawdownPct: 2, liquidityUsd: 900000 }
  });

  assert.ok(typeof fallbackRun.executionDecision.approve === "boolean", "Fallback path must return execution decision");
  const hasFallbackLogs = fallbackRun.logs.some((log) => log.source === "fallback");
  assert.ok(hasFallbackLogs, "Fallback run should emit fallback logs");

  const { pipeline: llmPipeline, telemetrySink: llmTelemetry } = buildPipeline(new MockDecisionRunner("llm"));
  const llmRun = await llmPipeline.runCycle({
    runId: "validate-llm-shape",
    query: { asset: "BTC/USDT", timeframe: "1h", limit: 50 },
    portfolio: { equityUsd: 100000, currentExposurePct: 10, currentDrawdownPct: 2, liquidityUsd: 900000 }
  });

  const logsByAgent = new Map(llmRun.logs.map((l) => [l.agent, l]));
  fundamentalsAnalysisSchema.parse(logsByAgent.get("FundamentalsAnalyst")?.outputPayload);
  sentimentAnalysisSchema.parse(logsByAgent.get("SentimentAnalyst")?.outputPayload);
  newsAnalysisSchema.parse(logsByAgent.get("NewsAnalyst")?.outputPayload);
  technicalAnalysisSchema.parse(logsByAgent.get("TechnicalAnalyst")?.outputPayload);
  debateOutputSchema.parse(logsByAgent.get("DebateSynthesizer")?.outputPayload);
  tradeProposalSchema.parse(logsByAgent.get("TraderAgent")?.outputPayload);
  riskDecisionSchema.parse(logsByAgent.get("RiskManager")?.outputPayload);
  executionDecisionSchema.parse(logsByAgent.get("PortfolioManager")?.outputPayload);

  const hasLlmLogs = llmRun.logs.some((log) => log.source === "llm");
  assert.ok(hasLlmLogs, "LLM run should emit llm-source logs");
  const uniqueTraceIds = new Set(llmRun.logs.map((log) => log.traceId));
  assert.equal(uniqueTraceIds.size, 1, "Trace correlation should keep one traceId across logs");
  const metricNames = llmTelemetry.getMetrics().map((sample) => sample.name);
  assert.ok(metricNames.includes("node_latency_ms"), "Telemetry should include node latency metric");
  assert.ok(metricNames.includes("run_latency_ms"), "Telemetry should include run latency metric");

  const { pipeline: retryPipeline } = buildPipeline(new MockDecisionRunner("retry_fallback"));
  const retryRun = await retryPipeline.runCycle({
    runId: "validate-retry",
    query: { asset: "BTC/USDT", timeframe: "1h", limit: 50 },
    portfolio: { equityUsd: 100000, currentExposurePct: 10, currentDrawdownPct: 2, liquidityUsd: 900000 }
  });

  const hasRetryMetadata = retryRun.logs.some((log) => log.retries >= 2 || log.decisionRationale.includes("Fallback"));
  assert.ok(hasRetryMetadata, "Retry/fallback run should carry retry or fallback metadata");

  const { pipeline: guardPipeline } = buildPipeline(new MockDecisionRunner("unsafe_llm"));
  const guardRun = await guardPipeline.runCycle({
    runId: "validate-hard-guard",
    query: { asset: "BTC/USDT", timeframe: "1h", limit: 50 },
    portfolio: { equityUsd: 100000, currentExposurePct: 34.9, currentDrawdownPct: 15, liquidityUsd: 100000 }
  });

  assert.equal(guardRun.executionDecision.approve, false, "Hard guards should reject unsafe LLM decision");

  const requiredAgents = [
    "MarketData",
    "FundamentalsAnalyst",
    "SentimentAnalyst",
    "NewsAnalyst",
    "TechnicalAnalyst",
    "BullishResearcher",
    "BearishResearcher",
    "DebateSynthesizer",
    "TraderAgent",
    "RiskManager",
    "PortfolioManager",
    "SimulatedExchange"
  ];

  for (const agent of requiredAgents) {
    const found = llmRun.logs.some((l) => l.agent === agent && typeof l.decisionRationale === "string");
    assert.ok(found, `Missing log event for ${agent}`);
  }

  const prettyReport = formatChatStyleRunReport({
    runId: "validate-llm-shape",
    mode: "backtest",
    query: { asset: "BTC/USDT", timeframe: "1h", limit: 50 },
    result: llmRun,
    outputFormat: "pretty"
  });
  for (const agent of requiredAgents) {
    assert.ok(prettyReport.includes(agent), `Pretty report should include agent ${agent}`);
  }
  assert.ok(prettyReport.includes("[LLM]") || prettyReport.includes("[FALLBACK]"), "Pretty report should include source markers");
  assert.ok(prettyReport.includes("rationale="), "Pretty report should include rationale metadata");
  assert.ok(prettyReport.includes("Trade proposal:"), "Pretty report should include trader summary");
  assert.ok(prettyReport.includes("Risk gate:"), "Pretty report should include risk summary");
  assert.ok(prettyReport.includes("Portfolio decision:"), "Pretty report should include portfolio summary");
  assert.ok(prettyReport.includes("Execution:"), "Pretty report should include exchange summary");

  const countOccurrences = (text: string, token: string): number => {
    const matched = text.match(new RegExp(token, "g"));
    return matched ? matched.length : 0;
  };
  assert.equal(countOccurrences(prettyReport, "FundamentalsAnalyst"), 1, "Pretty report should dedupe fallback duplicates per agent");
  assert.equal(countOccurrences(prettyReport, "SentimentAnalyst"), 1, "Pretty report should dedupe fallback duplicates per agent");
  assert.equal(countOccurrences(prettyReport, "TraderAgent"), 1, "Pretty report should dedupe fallback duplicates per agent");

  const captured: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (...args: unknown[]) => {
      captured.push(args.map((arg) => String(arg)).join(" "));
    };
    printRunReport({
      runId: "validate-json",
      mode: "backtest",
      query: { asset: "BTC/USDT", timeframe: "1h", limit: 50 },
      result: llmRun,
      outputFormat: "json"
    });
  } finally {
    console.log = originalLog;
  }

  assert.ok(captured.length > 0, "JSON output mode should print payload");
  const parsed = JSON.parse(captured[0]) as { result: { executionDecision: unknown } };
  assert.deepEqual(parsed.result.executionDecision, llmRun.executionDecision, "JSON mode should output raw result");

  const mockMarketFetcher = async (query: MarketDataQuery): Promise<{
    candles: OHLCVCandle[];
    lastPrice: number;
    status: ProviderFetchResult<{ asset: string; timeframe: string }>;
  }> => ({
    candles: [
      { timestamp: "2026-03-05T00:00:00.000Z", open: 70000, high: 71000, low: 69500, close: 70500, volume: 1000 },
      { timestamp: "2026-03-05T01:00:00.000Z", open: 70500, high: 71500, low: 70200, close: 71200, volume: 950 }
    ],
    lastPrice: 71200,
    status: {
      provider: "ccxt",
      ok: true,
      statusCode: 200,
      latencyMs: 3,
      recordCount: query.limit,
      data: { asset: query.asset, timeframe: query.timeframe }
    }
  });

  const okFetch: typeof fetch = async (url: string | URL | Request): Promise<Response> => {
    const href = typeof url === "string" ? url : String(url);
    if (href.includes("coingecko")) {
      return new Response(
        JSON.stringify([
          {
            market_cap: 1300000000000,
            fully_diluted_valuation: 1450000000000,
            circulating_supply: 19600000,
            total_supply: 21000000,
            total_volume: 35000000000,
            price_change_percentage_24h: 2.2
          }
        ]),
        { status: 200 }
      );
    }
    if (href.includes("alternative.me")) {
      return new Response(
        JSON.stringify({
          data: [{ value: "61", value_classification: "Greed" }]
        }),
        { status: 200 }
      );
    }
    if (href.includes("thenewsapi")) {
      return new Response(
        JSON.stringify({
          data: [
            { title: "Bitcoin adoption surges", description: "Institutional demand rises.", url: "https://example.com/1" },
            { title: "Regulator opens review", description: "No immediate ban announced.", url: "https://example.com/2" }
          ]
        }),
        { status: 200 }
      );
    }
    return new Response("not found", { status: 404 });
  };

  const realProvider = new RealCryptoDataProvider({
    strictRealMode: true,
    theNewsApiKey: "demo-news",
    coinGeckoApiKey: "",
    theNewsApiBaseUrl: "https://api.thenewsapi.com/v1/news",
    alternativeMeBaseUrl: "https://api.alternative.me",
    coinGeckoBaseUrl: "https://api.coingecko.com/api/v3",
    fetchFn: okFetch,
    marketFetcher: mockMarketFetcher
  });

  const realSnapshot = await realProvider.getSnapshot({ asset: "BTC/USDT", timeframe: "1h", limit: 2 });
  assert.ok(realSnapshot.fundamentals.marketCapUsd > 0, "CoinGecko mapper should produce marketCapUsd");
  assert.ok(realSnapshot.sentimentSignals.length > 0, "Alternative.me mapper should produce sentiment signals");
  assert.ok(realSnapshot.newsEvents.length > 0, "TheNewsAPI mapper should produce news events");

  const missingKeyProvider = new RealCryptoDataProvider({
    strictRealMode: true,
    theNewsApiKey: "",
    coinGeckoApiKey: "",
    theNewsApiBaseUrl: "https://api.thenewsapi.com/v1/news",
    alternativeMeBaseUrl: "https://api.alternative.me",
    coinGeckoBaseUrl: "https://api.coingecko.com/api/v3",
    fetchFn: okFetch,
    marketFetcher: mockMarketFetcher
  });

  await assert.rejects(
    () => missingKeyProvider.getSnapshot({ asset: "BTC/USDT", timeframe: "1h", limit: 2 }),
    (error: unknown) => error instanceof ProviderError,
    "Strict real mode should fail when required provider keys are missing"
  );

  const failingFetch: typeof fetch = async (url: string | URL | Request): Promise<Response> => {
    const href = typeof url === "string" ? url : String(url);
    if (href.includes("thenewsapi")) {
      return new Response(JSON.stringify({ status: "error" }), { status: 429 });
    }
    return okFetch(url);
  };

  const failingProvider = new RealCryptoDataProvider({
    strictRealMode: true,
    theNewsApiKey: "demo-news",
    coinGeckoApiKey: "",
    theNewsApiBaseUrl: "https://api.thenewsapi.com/v1/news",
    alternativeMeBaseUrl: "https://api.alternative.me",
    coinGeckoBaseUrl: "https://api.coingecko.com/api/v3",
    fetchFn: failingFetch,
    marketFetcher: mockMarketFetcher
  });

  await assert.rejects(
    () => failingProvider.getSnapshot({ asset: "BTC/USDT", timeframe: "1h", limit: 2 }),
    (error: unknown) => error instanceof ProviderError,
    "Strict real mode should fail on provider HTTP errors"
  );

  let nowMs = 1000;
  let thenewsHits = 0;
  let altHits = 0;
  let cgHits = 0;
  const cacheFetch: typeof fetch = async (url: string | URL | Request): Promise<Response> => {
    const href = typeof url === "string" ? url : String(url);
    if (href.includes("coingecko")) {
      cgHits += 1;
      return okFetch(url);
    }
    if (href.includes("alternative.me")) {
      altHits += 1;
      return okFetch(url);
    }
    if (href.includes("thenewsapi")) {
      thenewsHits += 1;
      return okFetch(url);
    }
    return okFetch(url);
  };

  const cacheProvider = new RealCryptoDataProvider({
    strictRealMode: true,
    theNewsApiKey: "demo-news",
    coinGeckoApiKey: "",
    theNewsApiBaseUrl: "https://api.thenewsapi.com/v1/news",
    alternativeMeBaseUrl: "https://api.alternative.me",
    coinGeckoBaseUrl: "https://api.coingecko.com/api/v3",
    providerCacheTtlSeconds: 300,
    fetchFn: cacheFetch,
    nowMs: () => nowMs,
    marketFetcher: mockMarketFetcher
  });

  await cacheProvider.getSnapshot({ asset: "BTC/USDT", timeframe: "1h", limit: 2 });
  await cacheProvider.getSnapshot({ asset: "BTC/USDT", timeframe: "1h", limit: 2 });
  assert.equal(cgHits, 1, "CoinGecko fetch should be cached within TTL");
  assert.equal(altHits, 1, "Alternative.me fetch should be cached within TTL");
  assert.equal(thenewsHits, 1, "TheNewsAPI fetch should be cached within TTL");

  nowMs += 301000;
  await cacheProvider.getSnapshot({ asset: "BTC/USDT", timeframe: "1h", limit: 2 });
  assert.equal(cgHits, 2, "CoinGecko fetch should refetch after TTL expiry");
  assert.equal(altHits, 2, "Alternative.me fetch should refetch after TTL expiry");
  assert.equal(thenewsHits, 2, "TheNewsAPI fetch should refetch after TTL expiry");

  const delayAttempt1 = computeBackoffDelay({ maxAttempts: 3, initialDelayMs: 100, backoffFactor: 2, maxDelayMs: 1000, jitterMs: 0 }, 1);
  const delayAttempt2 = computeBackoffDelay({ maxAttempts: 3, initialDelayMs: 100, backoffFactor: 2, maxDelayMs: 1000, jitterMs: 0 }, 2);
  assert.equal(delayAttempt1, 100, "Backoff attempt 1 should match initial delay when jitter is 0");
  assert.equal(delayAttempt2, 200, "Backoff attempt 2 should scale by factor");

  console.log("Validation checks passed.");
};

runDeterministicChecks().catch((error) => {
  console.error("Validation failed", error);
  process.exitCode = 1;
});












