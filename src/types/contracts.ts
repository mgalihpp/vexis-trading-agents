import type {
  AgentContext,
  AlertEvent,
  DecisionLogEntry,
  FundamentalsData,
  HealthStatus,
  MarketDataQuery,
  MarketSnapshot,
  MetricSample,
  NewsEvent,
  OHLCVCandle,
  ProviderFetchResult,
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
