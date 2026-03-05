import type { JSONObject, JSONValue } from "./json";

export type PipelineMode = "backtest" | "paper" | "live-sim";
export type OutputFormat = "pretty" | "json";
export type DecisionSource = "llm" | "fallback" | "system";
export type HealthState = "healthy" | "degraded" | "down";
export type AlertSeverity = "info" | "warning" | "critical";
export type MetricTagValue = string | number | boolean;
export type MetricTags = Record<string, MetricTagValue>;

export interface TimestampedPayload<T extends JSONValue> {
  timestamp: string;
  payload: T;
}

export interface AgentMessage<TIn extends JSONValue, TOut extends JSONValue> {
  agent: string;
  input: TIn;
  output: TOut;
  timestamp: string;
  rationale: string;
}

export interface LLMNodeConfig {
  nodeName: string;
  maxRetries: number;
}

export interface LLMRunnerResult<T> {
  output: T;
  source: DecisionSource;
  retries: number;
  decisionRationale: string;
}

export interface AgentDecisionEnvelope<T> {
  output: T;
  source: DecisionSource;
  retries: number;
  decisionRationale: string;
}

export interface RunReportSection {
  agent: string;
  time: string;
  source: DecisionSource;
  retries: number;
  rationale: string;
  input_summary: JSONValue;
  output_summary: JSONValue;
}

export interface AgentMessageView {
  agent: string;
  source: DecisionSource;
  retries: number;
  timestamp: string;
  headline: string;
  bullets: string[];
}

export interface DecisionLogEntry {
  runId: string;
  traceId: string;
  agent: string;
  timestamp: string;
  inputPayload: JSONValue;
  outputPayload: JSONValue;
  decisionRationale: string;
  source: DecisionSource;
  retries: number;
}

export interface TraceContext {
  trace_id: string;
  run_id: string;
  mode: PipelineMode;
  asset: string;
}

export interface MetricSample {
  name: string;
  value: number;
  timestamp: string;
  tags: MetricTags;
}

export interface TelemetryEvent {
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
  trace_id: string;
  tags: MetricTags;
  data?: JSONValue;
}

export interface AlertEvent {
  timestamp: string;
  name: string;
  severity: AlertSeverity;
  trace_id: string;
  tags: MetricTags;
  message: string;
  error_code?: string;
  node?: string;
  provider?: string;
  last_successful_run?: string;
}

export interface HealthStatus {
  target: string;
  kind: "provider" | "node" | "llm" | "system";
  state: HealthState;
  timestamp: string;
  message: string;
  tags: MetricTags;
}

export interface OHLCVCandle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FundamentalsData {
  peRatio?: number;
  earningsGrowthPct?: number;
  debtToEquity?: number;
  currentRatio?: number;
  revenueGrowthPct?: number;
  marketCapUsd: number;
  fdvUsd: number;
  circulatingSupplyRatio: number;
  volume24hUsd: number;
  onChainActivityScore: number;
}

export interface ProviderFetchResult<T> {
  provider: string;
  ok: boolean;
  statusCode: number;
  latencyMs: number;
  recordCount: number;
  data: T;
  message?: string;
}

export class ProviderError extends Error {
  public readonly provider: string;
  public readonly statusCode: number;
  public readonly code: string;

  public constructor(
    provider: string,
    statusCode: number,
    code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface SentimentSignal {
  source: string;
  score: number;
  rawText?: string;
  source_detail?: string;
}

export interface NewsEvent {
  title: string;
  sector: string;
  impact: "bullish" | "bearish" | "neutral";
  severity: number;
  url?: string;
}

export interface MarketSnapshot {
  asset: string;
  candles: OHLCVCandle[];
  fundamentals: FundamentalsData;
  sentimentSignals: SentimentSignal[];
  newsEvents: NewsEvent[];
  lastPrice: number;
  providerStatus: ProviderFetchResult<JSONValue>[];
}

export interface FundamentalsAnalysis {
  intrinsic_valuation_bias: "undervalued" | "fair" | "overvalued";
  red_flags: string[];
  confidence: number;
}

export interface SentimentAnalysis {
  sentiment_score: number;
  mood: "fearful" | "neutral" | "optimistic";
  confidence: number;
}

export interface NewsAnalysis {
  event_impact: "bullish" | "bearish" | "neutral";
  affected_sectors: string[];
  severity: number;
  confidence: number;
}

export interface IndicatorValues {
  rsi: number;
  macd: number;
  macdSignal: number;
  emaFast: number;
  emaSlow: number;
  atr: number;
}

export interface TechnicalAnalysis {
  indicators: IndicatorValues;
  trend: "up" | "down" | "sideways";
  signal: "buy" | "sell" | "hold";
  key_levels: {
    support: number;
    resistance: number;
  };
  confidence: number;
}

export interface AnalystBundle {
  fundamentals: FundamentalsAnalysis;
  sentiment: SentimentAnalysis;
  news: NewsAnalysis;
  technical: TechnicalAnalysis;
}

export interface BullishResearch {
  bullish_arguments: string[];
  reward_estimate_pct: number;
  confidence: number;
}

export interface BearishResearch {
  bearish_arguments: string[];
  failure_modes: string[];
  confidence: number;
}

export interface DebateOutput {
  bullish_arguments: string[];
  bearish_arguments: string[];
  final_bias: "bullish" | "bearish" | "neutral";
  confidence: number;
}

export interface TradeProposal {
  asset: string;
  side: "long" | "short";
  entry: number;
  stop_loss: number;
  take_profit: number;
  position_size_pct: number;
  timeframe: string;
  reasoning: string;
}

export interface RiskRules {
  maxRiskPerTradePct: number;
  maxExposurePct: number;
  drawdownCutoffPct: number;
  maxAtrPct: number;
  minLiquidityUsd: number;
}

export interface PortfolioState {
  equityUsd: number;
  currentExposurePct: number;
  currentDrawdownPct: number;
  liquidityUsd: number;
}

export interface RiskDecision {
  approved: boolean;
  adjusted_position_size_pct: number;
  risk_score: number;
  reasons: string[];
}

export interface ExecutionInstruction {
  type: "market" | "limit";
  tif: "IOC" | "GTC";
  side: "buy" | "sell";
  quantity_notional_usd: number;
}

export interface ExecutionDecision {
  approve: boolean;
  capital_allocated: number;
  execution_instructions: ExecutionInstruction | null;
  reasons: string[];
}

export interface Position {
  asset: string;
  side: "long" | "short";
  quantityNotionalUsd: number;
  avgEntry: number;
}

export interface PnLSnapshot {
  realizedUsd: number;
  unrealizedUsd: number;
  totalUsd: number;
}

export interface ExecutionReport {
  decision: ExecutionDecision;
  filled: boolean;
  fillPrice: number | null;
  position: Position | null;
  pnl: PnLSnapshot;
}

export interface AgentContext {
  runId: string;
  traceId: string;
  mode: PipelineMode;
  asset: string;
  nowIso: () => string;
}

export interface MarketDataQuery {
  asset: string;
  timeframe: string;
  limit: number;
  since?: number | undefined;
}

export interface StreamControl {
  stop: () => void;
}

export interface JSONEnvelope extends JSONObject {}
