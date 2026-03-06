import type {
  AgentContext,
  AlertEvent,
  BinanceAccountSnapshot,
  DecisionLogEntry,
  FundamentalsData,
  FuturesBalanceSnapshot,
  FuturesOrderRequest,
  FuturesOrderResult,
  FuturesPositionSnapshot,
  FuturesQuoteSnapshot,
  FuturesScope,
  FuturesTradeRecord,
  HealthStatus,
  MarketDataQuery,
  MarketSnapshot,
  MetricSample,
  NewsEvent,
  OHLCVCandle,
  PortfolioState,
  ProviderFetchResult,
  SpotBalanceSnapshot,
  SpotOrderRequest,
  SpotOrderResult,
  SpotQuoteSnapshot,
  SpotTradeRecord,
  SentimentSignal,
  TelemetryEvent
} from "./domain";

export interface Agent<I, O> {
  readonly name: string;
  run(input: I, ctx: AgentContext): Promise<O> | O;
}

export interface EventStorePersistence {
  save(events: DecisionLogEntry[]): Promise<void>;
  load(): Promise<DecisionLogEntry[]>;
}

export interface EventStore {
  append(event: DecisionLogEntry): Promise<void>;
  getAll(): DecisionLogEntry[];
  clear(): void;
}

export interface TelemetrySink {
  emitLog(event: TelemetryEvent): Promise<void>;
  emitMetric(sample: MetricSample): Promise<void>;
  emitAlert(event: AlertEvent): Promise<void>;
}

export interface HealthCheck {
  run(): Promise<HealthStatus>;
}

export interface MarketDataProvider {
  getSnapshot(query: MarketDataQuery): Promise<MarketSnapshot>;
  streamCandles?(query: MarketDataQuery): AsyncIterable<OHLCVCandle>;
  setRunContext?(ctx: {
    runId: string;
    traceId: string;
    mode: string;
    asset?: string;
  }): void;
}

export interface FundamentalsProvider {
  fetch(asset: string): Promise<ProviderFetchResult<FundamentalsData>>;
}

export interface SentimentProvider {
  fetch(asset: string): Promise<ProviderFetchResult<SentimentSignal[]>>;
}

export interface NewsProvider {
  fetch(asset: string): Promise<ProviderFetchResult<NewsEvent[]>>;
}

export interface SecretProvider {
  get(name: string): string | undefined;
}

export interface AccountStateProvider {
  getPortfolioState(ctx: {
    runId: string;
    traceId: string;
    mode: string;
    asset: string;
  }): Promise<PortfolioState>;
  getLastSnapshot(): BinanceAccountSnapshot | null;
  setRunContext?(ctx: {
    runId: string;
    traceId: string;
    mode: string;
    asset?: string;
  }): void;
}

export interface SpotTradingProvider {
  placeOrder(
    request: SpotOrderRequest,
    ctx: { runId: string; traceId: string; mode: "backtest" | "paper" | "live-sim" }
  ): Promise<SpotOrderResult>;
  fetchOrder(
    orderId: string,
    symbol: string,
    ctx: { runId: string; traceId: string; mode: "backtest" | "paper" | "live-sim" }
  ): Promise<SpotOrderResult>;
  fetchOpenOrders(
    ctx: { runId: string; traceId: string; mode: "backtest" | "paper" | "live-sim" },
    symbol?: string,
    limit?: number
  ): Promise<SpotOrderResult[]>;
  fetchClosedOrders(
    ctx: { runId: string; traceId: string; mode: "backtest" | "paper" | "live-sim" },
    symbol?: string,
    limit?: number
  ): Promise<SpotOrderResult[]>;
  cancelOrder(
    orderId: string,
    symbol: string,
    ctx: { runId: string; traceId: string; mode: "backtest" | "paper" | "live-sim" }
  ): Promise<SpotOrderResult>;
  cancelAllOrders(
    ctx: { runId: string; traceId: string; mode: "backtest" | "paper" | "live-sim" },
    symbol?: string
  ): Promise<SpotOrderResult[]>;
  fetchBalanceSnapshot(
    ctx: { runId: string; traceId: string; mode: "backtest" | "paper" | "live-sim" }
  ): Promise<SpotBalanceSnapshot>;
  fetchMyTrades(
    symbol: string,
    ctx: { runId: string; traceId: string; mode: "backtest" | "paper" | "live-sim" },
    limit?: number
  ): Promise<SpotTradeRecord[]>;
  fetchQuote(
    symbol: string,
    ctx: { runId: string; traceId: string; mode: "backtest" | "paper" | "live-sim" },
    depth?: number
  ): Promise<SpotQuoteSnapshot>;
}

export interface FuturesTradingProvider {
  placeOrder(
    request: FuturesOrderRequest,
    ctx: { runId: string; traceId: string; mode: "backtest" | "paper" | "live-sim" }
  ): Promise<FuturesOrderResult>;
  fetchOrder(
    scope: FuturesScope,
    orderId: string,
    symbol: string,
    ctx: { runId: string; traceId: string; mode: "backtest" | "paper" | "live-sim" }
  ): Promise<FuturesOrderResult>;
  fetchOpenOrders(
    scope: FuturesScope,
    ctx: { runId: string; traceId: string; mode: "backtest" | "paper" | "live-sim" },
    symbol?: string,
    limit?: number
  ): Promise<FuturesOrderResult[]>;
  fetchClosedOrders(
    scope: FuturesScope,
    ctx: { runId: string; traceId: string; mode: "backtest" | "paper" | "live-sim" },
    symbol?: string,
    limit?: number
  ): Promise<FuturesOrderResult[]>;
  cancelOrder(
    scope: FuturesScope,
    orderId: string,
    symbol: string,
    ctx: { runId: string; traceId: string; mode: "backtest" | "paper" | "live-sim" }
  ): Promise<FuturesOrderResult>;
  cancelAllOrders(
    scope: FuturesScope,
    ctx: { runId: string; traceId: string; mode: "backtest" | "paper" | "live-sim" },
    symbol?: string
  ): Promise<FuturesOrderResult[]>;
  fetchBalanceSnapshot(
    scope: FuturesScope,
    ctx: { runId: string; traceId: string; mode: "backtest" | "paper" | "live-sim" }
  ): Promise<FuturesBalanceSnapshot>;
  fetchPositions(
    scope: FuturesScope,
    ctx: { runId: string; traceId: string; mode: "backtest" | "paper" | "live-sim" },
    symbol?: string
  ): Promise<FuturesPositionSnapshot[]>;
  fetchMyTrades(
    scope: FuturesScope,
    symbol: string,
    ctx: { runId: string; traceId: string; mode: "backtest" | "paper" | "live-sim" },
    limit?: number
  ): Promise<FuturesTradeRecord[]>;
  fetchQuote(
    scope: FuturesScope,
    symbol: string,
    ctx: { runId: string; traceId: string; mode: "backtest" | "paper" | "live-sim" },
    depth?: number
  ): Promise<FuturesQuoteSnapshot>;
}

