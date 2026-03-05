import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { BinanceAccountProvider } from "../core/account-state";
import { InMemoryEventStore, SqliteEventStorePersistence } from "../core/event-store";
import { HealthMonitor } from "../core/health";
import { computeBackoffDelay } from "../core/ops";
import { BinanceSpotTradingService } from "../core/spot-trading";
import { InMemoryTelemetrySink, SqliteTelemetrySink } from "../core/telemetry";
import type { DecisionRunner } from "../core/llm-runner";
import { BacktestDataProvider, RealCryptoDataProvider } from "../core/market-data";
import { TradingPipeline } from "../core/pipeline";
import { RunnerService } from "../core/runner";
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
import { ProviderError, SpotGuardError } from "../types";

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

export const runDeterministicChecks = async (): Promise<void> => {
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

  const accountTelemetry = new InMemoryTelemetrySink(false);
  const accountHealth = new HealthMonitor(accountTelemetry, {
    maxP95RunLatencyMs: 30000,
    maxFallbackRatio: 0.5,
    maxConsecutiveFailures: 2
  });

  const mockAccountSpotClient = {
    fetchBalance: async () => ({
      free: { USDT: 800, BTC: 0.01 },
      total: { USDT: 1000, BTC: 0.02 }
    }),
    fetchTickers: async () => ({
      "BTC/USDT": { bid: 70000, ask: 70100, last: 70050 }
    })
  };
  const mockFuturesClient = {
    fetchBalance: async () => ({
      free: { USDT: 300 },
      total: { USDT: 500 }
    }),
    fetchTickers: async () => ({})
  };
  const mockCoinmClient = {
    fetchBalance: async () => ({
      free: { USDT: 120 },
      total: { USDT: 250 }
    }),
    fetchTickers: async () => ({})
  };

  const accountProvider = new BinanceAccountProvider({
    enabled: true,
    failHard: true,
    apiKey: "k",
    apiSecret: "s",
    accountScope: "spot+usdm+coinm",
    defaultExposurePct: 8,
    defaultDrawdownPct: 3,
    telemetrySink: accountTelemetry,
    healthMonitor: accountHealth,
    spotClient: mockAccountSpotClient,
    usdmClient: mockFuturesClient,
    coinmClient: mockCoinmClient
  });
  const portfolioState = await accountProvider.getPortfolioState({
    runId: "acct-run-1",
    traceId: "acct-trace-1",
    mode: "paper",
    asset: "BTC/USDT"
  });
  assert.ok(portfolioState.equityUsd > 0, "Binance account provider should map equity from spot+usdm+coinm");
  assert.ok(portfolioState.liquidityUsd > 0, "Binance account provider should map liquidity from spot+usdm+coinm");
  assert.equal(
    accountTelemetry.getMetrics().some((m) => m.name === "binance_account_fetch_success" && m.value === 1),
    true,
    "Binance account provider should emit success metric"
  );
  assert.equal(
    accountTelemetry.getMetrics().some((m) => m.name === "binance_account_usdm_fetch_success" && m.value === 1),
    true,
    "Binance account provider should emit USD-M success metric"
  );
  assert.equal(
    accountTelemetry.getMetrics().some((m) => m.name === "binance_account_coinm_fetch_success" && m.value === 1),
    true,
    "Binance account provider should emit COIN-M success metric"
  );

  const failingAccountProvider = new BinanceAccountProvider({
    enabled: true,
    failHard: true,
    apiKey: "k",
    apiSecret: "s",
    accountScope: "spot+usdm+coinm",
    defaultExposurePct: 8,
    defaultDrawdownPct: 3,
    spotClient: {
      fetchBalance: async () => {
        throw new Error("account down");
      },
      fetchTickers: async () => ({})
    },
    usdmClient: mockFuturesClient,
    coinmClient: mockCoinmClient
  });

  await assert.rejects(
    () =>
      failingAccountProvider.getPortfolioState({
        runId: "acct-run-2",
        traceId: "acct-trace-2",
        mode: "paper",
        asset: "BTC/USDT"
      }),
    (error: unknown) => error instanceof ProviderError,
    "Fail-hard account provider should throw on balance fetch error"
  );

  const spotTelemetry = new InMemoryTelemetrySink(false);
  const mockSpotClient = {
    loadMarkets: async () => ({
      "BTC/USDT": {
        symbol: "BTC/USDT",
        spot: true,
        limits: {
          amount: { min: 0.0001, max: 100 },
          cost: { min: 5 }
        }
      }
    }),
    createOrder: async (
      symbol: string,
      type: string,
      side: string,
      amount?: number,
      price?: number
    ) => ({
      id: "order-1",
      symbol,
      status: "open",
      side,
      type,
      amount,
      price,
      filled: 0,
      remaining: amount,
      cost: amount && price ? amount * price : 0,
      timestamp: 1700000000000
    }),
    fetchOrder: async (id: string, symbol: string) => ({
      id,
      symbol,
      status: "closed",
      side: "buy",
      type: "limit",
      amount: 0.01,
      price: 70000,
      filled: 0.01,
      remaining: 0,
      cost: 700,
      timestamp: 1700000000000
    }),
    fetchOpenOrders: async () => [],
    fetchClosedOrders: async () => [],
    cancelOrder: async (id: string, symbol: string) => ({
      id,
      symbol,
      status: "canceled",
      side: "buy",
      type: "limit",
      amount: 0.01,
      price: 70000,
      timestamp: 1700000000000
    }),
    cancelAllOrders: async () => [],
    fetchBalance: async () => ({
      free: { USDT: 1000, BTC: 0.01 },
      used: { USDT: 0, BTC: 0 },
      total: { USDT: 1000, BTC: 0.01 }
    }),
    fetchMyTrades: async () => [
      {
        id: "trade-1",
        order: "order-1",
        symbol: "BTC/USDT",
        side: "buy",
        price: 70000,
        amount: 0.01,
        cost: 700,
        fee: { cost: 0.7, currency: "USDT" },
        timestamp: 1700000000000
      }
    ],
    fetchTicker: async () => ({ bid: 70000, ask: 70100, last: 70050 }),
    fetchTickers: async () => ({
      "BTC/USDT": { bid: 70000, ask: 70100, last: 70050 }
    }),
    fetchOrderBook: async () => ({
      bids: [[70000, 1]] as Array<[number, number]>,
      asks: [[70100, 1]] as Array<[number, number]>
    }),
    amountToPrecision: (_symbol: string, amount: number) => String(amount),
    priceToPrecision: (_symbol: string, price: number) => String(price)
  };

  const spotService = BinanceSpotTradingService.getInstance({
    enabled: true,
    apiKey: "k",
    apiSecret: "s",
    symbolWhitelist: ["BTC/USDT"],
    defaultTif: "GTC",
    recvWindow: 10000,
    timeoutMs: 5000,
    telemetrySink: spotTelemetry,
    mode: "paper",
    client: mockSpotClient
  });

  await assert.rejects(
    () =>
      spotService.placeOrder(
        {
          symbol: "ETH/USDT",
          side: "buy",
          type: "market",
          amount: 0.01
        },
        { runId: "spot-1", traceId: "spot-1", mode: "paper" }
      ),
    (error: unknown) => error instanceof SpotGuardError,
    "Spot guard should reject symbols outside whitelist"
  );

  await assert.rejects(
    () =>
      spotService.placeOrder(
        {
          symbol: "BTC/USDT",
          side: "buy",
          type: "limit",
          amount: 0.00001,
          price: 70000
        },
        { runId: "spot-2", traceId: "spot-2", mode: "paper" }
      ),
    (error: unknown) => error instanceof SpotGuardError,
    "Spot guard should reject amount below minimum"
  );

  const placed = await spotService.placeOrder(
    {
      symbol: "BTC/USDT",
      side: "buy",
      type: "limit",
      amount: 0.01,
      price: 70000
    },
    { runId: "spot-3", traceId: "spot-3", mode: "paper" }
  );
  assert.equal(placed.orderId, "order-1", "Spot placeOrder should map order id");

  const quote = await spotService.fetchQuote("BTC/USDT", { runId: "spot-4", traceId: "spot-4", mode: "paper" }, 1);
  assert.ok(quote.bid > 0 && quote.ask > 0, "Spot quote should include bid/ask");
  const trades = await spotService.fetchMyTrades("BTC/USDT", { runId: "spot-5", traceId: "spot-5", mode: "paper" }, 10);
  assert.equal(trades.length, 1, "Spot trades should map trade records");
  const balance = await spotService.fetchBalanceSnapshot({ runId: "spot-6", traceId: "spot-6", mode: "paper" });
  assert.ok(balance.total_assets > 0, "Spot balance snapshot should include assets");
  assert.equal(
    spotTelemetry.getMetrics().some((m) => m.name === "spot_action_success"),
    true,
    "Spot actions should emit success/failure metrics"
  );

  const delayAttempt1 = computeBackoffDelay({ maxAttempts: 3, initialDelayMs: 100, backoffFactor: 2, maxDelayMs: 1000, jitterMs: 0 }, 1);
  const delayAttempt2 = computeBackoffDelay({ maxAttempts: 3, initialDelayMs: 100, backoffFactor: 2, maxDelayMs: 1000, jitterMs: 0 }, 2);
  assert.equal(delayAttempt1, 100, "Backoff attempt 1 should match initial delay when jitter is 0");
  assert.equal(delayAttempt2, 200, "Backoff attempt 2 should scale by factor");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vexis-obs-"));
  const dbPath = path.join(tmpDir, "observability.db");

  const sqliteTelemetry = new SqliteTelemetrySink(dbPath);
  await sqliteTelemetry.emitMetric({
    name: "run_success",
    value: 1,
    timestamp: "2026-03-05T00:00:00.000Z",
    tags: {
      run_id: "run-sql-1",
      trace_id: "trace-sql-1",
      mode: "backtest",
      asset: "BTC/USDT",
      node: "Pipeline",
      provider: "",
      source: "system"
    }
  });
  await sqliteTelemetry.emitAlert({
    timestamp: "2026-03-05T00:00:01.000Z",
    name: "provider_fail_hard",
    severity: "critical",
    trace_id: "trace-sql-1",
    tags: {
      run_id: "run-sql-1",
      trace_id: "trace-sql-1",
      mode: "backtest",
      asset: "BTC/USDT",
      node: "Pipeline",
      provider: "thenewsapi",
      source: "system"
    },
    message: "provider down"
  });

  const recentRuns = sqliteTelemetry.getRecentRuns(5);
  assert.ok(recentRuns.some((r) => r.run_id === "run-sql-1"), "SQLite telemetry should persist recent runs");
  const recentAlerts = sqliteTelemetry.getAlerts({
    sinceIso: "2026-03-05T00:00:00.000Z",
    severity: "critical"
  });
  assert.ok(recentAlerts.some((a) => a.name === "provider_fail_hard"), "SQLite telemetry should persist alerts");

  const eventPersistence = new SqliteEventStorePersistence(dbPath);
  const persistStore = new InMemoryEventStore(eventPersistence);
  await persistStore.append({
    runId: "run-sql-1",
    traceId: "trace-sql-1",
    agent: "TraderAgent",
    timestamp: "2026-03-05T00:00:02.000Z",
    inputPayload: { ok: true },
    outputPayload: { ok: true },
    decisionRationale: "persist test",
    source: "system",
    retries: 0
  });
  const loaded = await eventPersistence.load();
  assert.ok(loaded.some((e) => e.runId === "run-sql-1" && e.agent === "TraderAgent"), "SQLite event persistence should restore logs");

  const runTrace = sqliteTelemetry.getRunTrace({ runId: "run-sql-1" });
  assert.ok(runTrace.metrics.length > 0, "SQLite run trace should include metrics");
  const purged = sqliteTelemetry.purgeOlderThan("2026-03-06T00:00:00.000Z");
  assert.ok(purged.telemetryMetricsDeleted >= 1, "Retention purge should delete old telemetry metrics");

  const exchStore = new InMemoryEventStore();
  const realisticExchange = new SimulatedExchange(exchStore, {
    feeBps: 10,
    slippageBps: 5,
    partialFillEnabled: true
  });
  const executionReport = await realisticExchange.run(
    {
      decision: {
        approve: true,
        capital_allocated: 1000,
        execution_instructions: {
          type: "market",
          tif: "IOC",
          side: "buy",
          quantity_notional_usd: 1000
        },
        reasons: ["validate"]
      },
      proposal: {
        asset: "BTC/USDT",
        side: "long",
        entry: 70000,
        stop_loss: 68000,
        take_profit: 74000,
        position_size_pct: 30,
        timeframe: "1h",
        reasoning: "validate"
      },
      marketPrice: 70000
    },
    { runId: "x", traceId: "t", mode: "backtest", asset: "BTC/USDT", nowIso: () => "2026-03-05T00:00:00.000Z" }
  );
  assert.ok(executionReport.execution_details, "Execution report should include execution_details");
  assert.ok((executionReport.execution_details?.order_events.length ?? 0) >= 2, "Execution details should include order lifecycle events");


  console.log("Validation checks passed.");
};

const isDirectRun = process.argv[1]?.includes("validate");
if (isDirectRun) {
  runDeterministicChecks().catch((error) => {
    console.error("Validation failed", error);
    process.exitCode = 1;
  });
}



















