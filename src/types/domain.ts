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

export type TechnicalDirection = "buy" | "sell" | "hold";
export type TrendState = "up" | "down" | "sideways";
export type StructureState = "bullish" | "bearish" | "neutral";
export type RegimeState = "low_vol" | "trend" | "high_vol_news";
export type ConfidenceBucket = "low" | "medium" | "high";

export interface TechnicalFeatures {
  rsi14: number;
  macd: number;
  macdSignal: number;
  ema9: number;
  ema21: number;
  atr14: number;
  adx14: number;
  atrPercentile: number;
  volumeZScore: number;
  wickBodyRatio: number;
  realizedVolatility: number;
}

export interface StructureAnalysis {
  trend: TrendState;
  state: StructureState;
  bos: boolean;
  choch: boolean;
  swing_high: number;
  swing_low: number;
  support: number;
  resistance: number;
}

export interface LiquidityAnalysis {
  sweep_detected: boolean;
  sweep_side: "buy_side" | "sell_side" | "none";
  sweep_score: number;
  stop_hunt_score: number;
}

export interface OrderBlockZone {
  side: "demand" | "supply";
  low: number;
  high: number;
  strength: number;
  mitigation_count: number;
  age_candles: number;
}

export interface ImbalanceZone {
  side: "bullish" | "bearish";
  low: number;
  high: number;
  gap_size_pct: number;
  fill_probability: number;
}

export interface SmartMoneyAnalysis {
  order_blocks: OrderBlockZone[];
  imbalances: ImbalanceZone[];
  smc_score: number;
}

export interface RegimeAnalysis {
  state: RegimeState;
  transition_probability: number;
  volatility_score: number;
  detection_latency_candles: number;
}

export interface ConfirmationAnalysis {
  orthogonal_score: number;
  collinearity_risk: number;
  mtf_alignment_score: number;
  htf_bias: "bullish" | "bearish" | "neutral";
}

export interface SignalAnalysis {
  direction: TechnicalDirection;
  calibrated_probability: number;
  confidence_bucket: ConfidenceBucket;
  composite_score: number;
}

export interface LegacyTechnicalSnapshot {
  trend: TrendState;
  signal: TechnicalDirection;
  confidence: number;
  support: number;
  resistance: number;
}

export interface ShadowComparison {
  enabled: boolean;
  baseline: LegacyTechnicalSnapshot;
  agreement: boolean;
}

export interface TechnicalAnalysis {
  features: TechnicalFeatures;
  structure: StructureAnalysis;
  liquidity: LiquidityAnalysis;
  smc: SmartMoneyAnalysis;
  regime: RegimeAnalysis;
  confirmation: ConfirmationAnalysis;
  signals: SignalAnalysis;
  shadow: ShadowComparison;
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

export interface OrderFillEvent {
  order_status: "new" | "partial" | "filled" | "canceled";
  filled_notional_usd: number;
  remaining_notional_usd: number;
  fill_price: number;
  fee_usd: number;
  slippage_bps: number;
}

export interface ExecutionDetails {
  fee_bps: number;
  fee_usd: number;
  slippage_bps: number;
  slippage_usd: number;
  order_events: OrderFillEvent[];
}

export interface ExecutionReport {
  decision: ExecutionDecision;
  filled: boolean;
  fillPrice: number | null;
  position: Position | null;
  pnl: PnLSnapshot;
  execution_details?: ExecutionDetails;
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

export interface ObservabilityStorageConfig {
  persistEnabled: boolean;
  sqlitePath: string;
}

export interface RunnerConfig {
  enabled: boolean;
  intervalSeconds: number;
  candleAlign: boolean;
  maxBackoffSeconds: number;
  query: MarketDataQuery;
  portfolio: PortfolioState;
}

export interface RunnerState {
  status: "idle" | "running" | "stopped";
  backoffLevel: number;
  currentIntervalSeconds: number;
  nextRunAtIso: string;
  lastRunId?: string;
  lastTraceId?: string;
  consecutiveFailures: number;
}

export interface RetentionConfig {
  enabled: boolean;
  retentionDays: number;
}

export interface HealthServerConfig {
  enabled: boolean;
  port: number;
}

export interface RunnerHeartbeatMetric {
  status: "normal" | "backoff" | "stopped";
  intervalSeconds: number;
  backoffLevel: number;
  timestamp: string;
}

export interface BinanceAccountSnapshot {
  provider: "binance-account";
  scope: "spot+usdm+coinm";
  spot_equity_usd: number;
  spot_liquidity_usd: number;
  usdm_equity_usd: number;
  usdm_liquidity_usd: number;
  coinm_equity_usd: number;
  coinm_liquidity_usd: number;
  total_equity_usd: number;
  total_liquidity_usd: number;
  spot_assets_count: number;
  usdm_assets_count: number;
  coinm_assets_count: number;
  timestamp: string;
}

export interface CliGlobalOptions {
  json?: boolean;
  output?: OutputFormat;
  mode?: PipelineMode;
  envFile?: string;
}

export interface CliCommandResult {
  exitCode: number;
  message?: string;
  data?: JSONValue;
}

export interface EffectiveConfigView {
  effective: Record<string, JSONValue>;
  source: Record<string, "flag" | "env" | "default">;
}

export type SpotOrderType = "market" | "limit";
export type SpotOrderSide = "buy" | "sell";
export type SpotTimeInForce = "GTC" | "IOC" | "FOK";

export interface SpotOrderRequest {
  symbol: string;
  side: SpotOrderSide;
  type: SpotOrderType;
  amount?: number;
  quoteCost?: number;
  price?: number;
  tif?: SpotTimeInForce;
  clientOrderId?: string;
}

export interface SpotOrderResult {
  exchange: "binance";
  symbol: string;
  orderId: string;
  clientOrderId?: string;
  status: string;
  side: SpotOrderSide;
  type: SpotOrderType;
  timeInForce?: SpotTimeInForce;
  amount: number | null;
  price: number | null;
  average: number | null;
  filled: number | null;
  remaining: number | null;
  cost: number | null;
  timestamp: string;
}

export interface SpotBalanceAsset {
  asset: string;
  free: number;
  used: number;
  total: number;
  usdt_estimate: number;
}

export interface SpotBalanceSnapshot {
  exchange: "binance";
  timestamp: string;
  total_assets: number;
  total_usdt_estimate: number;
  assets: SpotBalanceAsset[];
  top_exposure: SpotBalanceAsset[];
}

export interface SpotTradeRecord {
  id: string;
  orderId?: string;
  symbol: string;
  side: SpotOrderSide;
  price: number;
  amount: number;
  cost: number;
  feeCost?: number;
  feeCurrency?: string;
  timestamp: string;
}

export interface SpotQuoteSnapshot {
  symbol: string;
  timestamp: string;
  bid: number;
  ask: number;
  last: number;
  spread_bps: number;
  orderbook_top: {
    bids: Array<[number, number]>;
    asks: Array<[number, number]>;
  };
}

export class SpotGuardError extends Error {
  public readonly code: string;
  public readonly detail?: JSONValue;

  public constructor(code: string, message: string, detail?: JSONValue) {
    super(message);
    this.name = "SpotGuardError";
    this.code = code;
    this.detail = detail;
  }
}

export type FuturesScope = "usdm" | "coinm";
export type FuturesOrderType = "market" | "limit";
export type FuturesOrderSide = "buy" | "sell";
export type FuturesTimeInForce = "GTC" | "IOC" | "FOK";
export type FuturesMarginMode = "isolated" | "cross";
export type FuturesPositionMode = "oneway" | "hedge";

export interface FuturesOrderRequest {
  scope: FuturesScope;
  symbol: string;
  side: FuturesOrderSide;
  type: FuturesOrderType;
  amount: number;
  price?: number;
  tif?: FuturesTimeInForce;
  reduceOnly?: boolean;
  clientOrderId?: string;
}

export interface FuturesOrderResult {
  exchange: "binance";
  scope: FuturesScope;
  symbol: string;
  orderId: string;
  clientOrderId?: string;
  status: string;
  side: FuturesOrderSide;
  type: FuturesOrderType;
  timeInForce?: FuturesTimeInForce;
  amount: number | null;
  price: number | null;
  average: number | null;
  filled: number | null;
  remaining: number | null;
  cost: number | null;
  reduceOnly: boolean;
  timestamp: string;
}

export interface FuturesBalanceAsset {
  asset: string;
  free: number;
  used: number;
  total: number;
}

export interface FuturesBalanceSnapshot {
  exchange: "binance";
  scope: FuturesScope;
  timestamp: string;
  assets: FuturesBalanceAsset[];
}

export interface FuturesPositionSnapshot {
  symbol: string;
  side: "long" | "short";
  contracts: number;
  entryPrice: number;
  markPrice: number;
  leverage: number;
  notionalUsd: number;
  unrealizedPnlUsd: number;
  marginMode: FuturesMarginMode;
}

export interface FuturesTradeRecord {
  id: string;
  orderId?: string;
  symbol: string;
  side: FuturesOrderSide;
  price: number;
  amount: number;
  cost: number;
  feeCost?: number;
  feeCurrency?: string;
  timestamp: string;
}

export interface FuturesQuoteSnapshot {
  scope: FuturesScope;
  symbol: string;
  timestamp: string;
  bid: number;
  ask: number;
  last: number;
  spread_bps: number;
  orderbook_top: {
    bids: Array<[number, number]>;
    asks: Array<[number, number]>;
  };
}

export class FuturesGuardError extends Error {
  public readonly code: string;
  public readonly detail?: JSONValue;

  public constructor(code: string, message: string, detail?: JSONValue) {
    super(message);
    this.name = "FuturesGuardError";
    this.code = code;
    this.detail = detail;
  }
}
