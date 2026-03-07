import { z } from "zod";

export const confidenceVectorSchema = z.object({
  signal_confidence: z.number().min(0).max(1),
  data_quality_confidence: z.number().min(0).max(1),
  model_reliability: z.number().min(0).max(1),
  effective_confidence: z.number().min(0).max(1),
});

export const evidenceItemSchema = z.object({
  summary: z.string().min(1),
  evidence_source: z.array(z.string()).min(1),
  causal_tag: z.string().min(1),
  time_horizon: z.enum(["scalp", "intraday", "swing", "position"]),
  novelty_score: z.number().min(0).max(1),
  dependency_group: z.string().min(1),
  weight: z.number().min(0).max(1),
});

export const fundamentalsAnalysisSchema = z.object({
  intrinsic_valuation_bias: z.enum(["undervalued", "fair", "overvalued"]),
  red_flags: z.array(z.string()),
  confidence: confidenceVectorSchema,
  evidence: z.array(evidenceItemSchema),
});

export const sentimentAnalysisSchema = z.object({
  sentiment_score: z.number().min(-1).max(1),
  mood: z.enum(["fearful", "neutral", "optimistic"]),
  confidence: confidenceVectorSchema,
  evidence: z.array(evidenceItemSchema),
});

export const newsAnalysisSchema = z.object({
  event_impact: z.enum(["bullish", "bearish", "neutral"]),
  affected_sectors: z.array(z.string()),
  severity: z.number().min(0).max(1),
  confidence: confidenceVectorSchema,
  evidence: z.array(evidenceItemSchema),
});

export const technicalAnalysisSchema = z.object({
  features: z.object({
    rsi14: z.number(),
    macd: z.number(),
    macdSignal: z.number(),
    ema9: z.number(),
    ema21: z.number(),
    atr14: z.number(),
    adx14: z.number(),
    atrPercentile: z.number().min(0).max(1),
    volumeZScore: z.number(),
    wickBodyRatio: z.number(),
    realizedVolatility: z.number().min(0),
  }),
  structure: z.object({
    trend: z.enum(["up", "down", "sideways"]),
    state: z.enum(["bullish", "bearish", "neutral"]),
    bos: z.boolean(),
    choch: z.boolean(),
    swing_high: z.number(),
    swing_low: z.number(),
    support: z.number(),
    resistance: z.number(),
  }),
  liquidity: z.object({
    sweep_detected: z.boolean(),
    sweep_side: z.enum(["buy_side", "sell_side", "none"]),
    sweep_score: z.number().min(0).max(1),
    stop_hunt_score: z.number().min(0).max(1),
  }),
  smc: z.object({
    order_blocks: z.array(
      z.object({
        side: z.enum(["demand", "supply"]),
        low: z.number(),
        high: z.number(),
        strength: z.number().min(0).max(1),
        mitigation_count: z.number().min(0),
        age_candles: z.number().min(0),
      }),
    ),
    imbalances: z.array(
      z.object({
        side: z.enum(["bullish", "bearish"]),
        low: z.number(),
        high: z.number(),
        gap_size_pct: z.number().min(0),
        fill_probability: z.number().min(0).max(1),
      }),
    ),
    smc_score: z.number().min(0).max(1),
  }),
  regime: z.object({
    state: z.enum(["low_vol", "trend", "high_vol_news"]),
    transition_probability: z.number().min(0).max(1),
    volatility_score: z.number().min(0).max(1),
    detection_latency_candles: z.number().min(0),
  }),
  confirmation: z.object({
    orthogonal_score: z.number().min(0).max(1),
    collinearity_risk: z.number().min(0).max(1),
    mtf_alignment_score: z.number().min(0).max(1),
    htf_bias: z.enum(["bullish", "bearish", "neutral"]),
  }),
  signals: z.object({
    direction: z.enum(["buy", "sell", "hold"]),
    calibrated_probability: z.number().min(0).max(1),
    confidence_bucket: z.enum(["low", "medium", "high"]),
    composite_score: z.number(),
    confidence: confidenceVectorSchema,
  }),
  shadow: z.object({
    enabled: z.boolean(),
    baseline: z.object({
      trend: z.enum(["up", "down", "sideways"]),
      signal: z.enum(["buy", "sell", "hold"]),
      confidence: z.number().min(0).max(1),
      support: z.number(),
      resistance: z.number(),
    }),
    agreement: z.boolean(),
  }),
  evidence: z.array(evidenceItemSchema),
});

export const analystBundleSchema = z.object({
  fundamentals: fundamentalsAnalysisSchema,
  sentiment: sentimentAnalysisSchema,
  news: newsAnalysisSchema,
  technical: technicalAnalysisSchema,
  normalized_evidence: z.array(evidenceItemSchema),
  dependency_overlap_score: z.number().min(0).max(1),
  data_quality: z.object({
    market_data_freshness_sec: z.number().min(0),
    news_data_quality: z.enum(["low", "medium", "high"]),
    sentiment_data_quality: z.enum(["low", "medium", "high"]),
    provider_health_score: z.number().min(0).max(1),
    degraded_providers: z.array(z.string()),
  }),
});

const researchSchema = z.object({
  thesis: z.array(z.string()),
  expected_move_pct: z.number(),
  time_horizon: z.enum(["scalp", "intraday", "swing", "position"]),
  invalidation_triggers: z.array(z.string()),
  confidence: confidenceVectorSchema,
});

export const bullishResearchSchema = researchSchema;
export const bearishResearchSchema = researchSchema;

export const debateOutputSchema = z.object({
  bullish_thesis: z.array(z.string()),
  bearish_thesis: z.array(z.string()),
  final_bias: z.enum(["bullish", "bearish", "neutral"]),
  dominant_horizon: z.enum(["scalp", "intraday", "swing", "position"]),
  expected_move_pct: z.number(),
  key_disagreement: z.string(),
  must_monitor_conditions: z.array(z.string()),
  invalidation_triggers: z.array(z.string()),
  decision_stability: z.enum(["low", "medium", "high"]),
  confidence: confidenceVectorSchema,
});

export const overrideTraceSchema = z.object({
  advisory_source: z.enum(["proposal", "risk", "portfolio", "execution"]),
  advisory_signal: z.string().min(1),
  llm_signal: z.string().min(1),
  reason: z.string().min(3),
});

export const noTradeDecisionSchema = z.object({
  no_trade: z.literal(true),
  reasons: z.array(z.string()),
  dominant_horizon: z.enum(["scalp", "intraday", "swing", "position"]),
  confidence: confidenceVectorSchema,
  must_monitor_conditions: z.array(z.string()),
});

export const tradeProposalSchema = z.object({
  proposal_type: z.literal("trade"),
  asset: z.string(),
  side: z.enum(["long", "short"]),
  execution_venue: z.literal("futures"),
  leverage: z.number().min(1),
  entry: z.number(),
  stop_loss: z.number(),
  take_profit_targets: z.array(z.number()).min(1),
  tp_partial_close_pct: z.array(z.number().min(0)).min(1),
  move_stop_to_breakeven_after_tp1: z.boolean(),
  suggested_position_size_pct_equity: z.number().min(0),
  input_timeframe: z.string(),
  decision_horizon: z.enum(["scalp", "intraday", "swing", "position"]),
  expected_holding_period_hours: z.number().min(0),
  risk_reward_ratio: z.number().min(0),
  stop_distance_pct: z.number().min(0),
  stop_distance_fraction: z.number().min(0),
  take_profit_distance_pct: z.number().min(0),
  structural_invalidation_level: z.number(),
  thesis: z.array(z.string()),
  entry_rationale: z.string(),
  stop_loss_rationale: z.string(),
  take_profit_rationale: z.string(),
  invalid_if: z.array(z.string()),
  confidence: confidenceVectorSchema,
});

export const noTradeProposalSchema = z.object({
  proposal_type: z.literal("no_trade"),
  asset: z.string(),
  input_timeframe: z.string(),
  decision_horizon: z.enum(["scalp", "intraday", "swing", "position"]),
  reasons: z.array(z.string()),
  must_monitor_conditions: z.array(z.string()),
  confidence: confidenceVectorSchema,
});

export const proposalDecisionSchema = z.discriminatedUnion("proposal_type", [
  tradeProposalSchema,
  noTradeProposalSchema,
]);

export const riskDecisionSchema = z.object({
  action: z.enum(["approve", "reduce", "reject"]),
  approved: z.boolean(),
  approved_position_size_pct_equity: z.number().min(0),
  risk_score_raw: z.number().min(0),
  risk_score_normalized: z.number().min(0).max(1),
  risk_band: z.enum(["low", "medium", "medium_high", "high"]),
  evaluation_state: z.enum(["evaluated", "not_applicable"]),
  binding_constraints: z.array(z.string()),
  reasons: z.array(z.string()),
});

export const portfolioDecisionSchema = z.object({
  approved: z.boolean(),
  approved_position_size_pct_equity: z.number().min(0),
  approved_notional_usd: z.number().min(0),
  concentration_check: z.enum(["pass", "fail", "not_applicable"]),
  correlation_check: z.enum(["pass", "fail", "not_applicable"]),
  reserve_cash_check: z.enum(["pass", "fail", "not_applicable"]),
  reasons: z.array(z.string()),
});

export const executionDecisionSchema = z.object({
  execution_venue: z.literal("futures"),
  portfolio_approved: z.boolean(),
  executable: z.boolean(),
  approved_notional_usd: z.number().min(0),
  risk_budget_usd: z.number().min(0).nullable(),
  effective_risk_usd: z.number().min(0).nullable(),
  required_margin_usd: z.number().min(0).nullable(),
  leverage_used: z.number().min(1).nullable(),
  execution_blocker: z.string().nullable(),
  execution_instructions: z
    .object({
      venue: z.literal("futures"),
      type: z.enum(["market", "limit"]),
      tif: z.enum(["IOC", "GTC"]),
      side: z.enum(["buy", "sell"]),
      leverage: z.number().min(1),
      quantity_notional_usd: z.number().min(0),
      required_margin_usd: z.number().min(0).optional(),
      min_notional_usd: z.number().min(0).optional(),
      precision_step: z.number().min(0).optional(),
      metadata_source: z.enum(["exchange", "fallback_env"]).optional(),
    })
    .nullable(),
  reasons: z.array(z.string()),
});

export const advisorySnapshotSchema = z.object({
  asset: z.string(),
  timeframe: z.string(),
  market_price: z.number().min(0),
  debate: debateOutputSchema,
  proposal_advisory: proposalDecisionSchema,
  risk_advisory: riskDecisionSchema,
  portfolio_advisory: portfolioDecisionSchema,
  execution_advisory: executionDecisionSchema,
});

export const finalDecisionToolArgsSchema = z.object({
  action: z.enum(["execute_trade", "no_trade"]),
  reasons: z.array(z.string().min(1)).min(1),
  override_trace: z.array(overrideTraceSchema),
  final_confidence: confidenceVectorSchema,
  must_monitor_conditions: z.array(z.string()),
});

export const finalDecisionByLLMSchema = finalDecisionToolArgsSchema.extend({
  decision_origin: z.literal("llm_tool_call"),
});

export const llmDecisionAbortSchema = z.object({
  decision_origin: z.literal("llm_abort"),
  abort: z.literal(true),
  error_code: z.literal("llm_tool_call_failed"),
  reason: z.string().min(3),
  retries_exhausted: z.number().min(0),
});

export const postTradeEvaluationSchema = z.object({
  evaluation_type: z.enum(["trade", "no_trade"]),
  slippage_vs_expected_bps: z.number(),
  entry_quality_score: z.number().min(0).max(1).nullable(),
  stop_placement_quality_score: z.number().min(0).max(1).nullable(),
  tp_realism_score: z.number().min(0).max(1).nullable(),
  proposal_to_fill_delay_ms: z.number().min(0),
  realized_risk_vs_predicted: z.number(),
  thesis_outcome: z.enum(["success", "failed", "inconclusive"]),
  abstention_quality_score: z.number().min(0).max(1).nullable(),
  missed_opportunity_score: z.number().min(0).max(1).nullable(),
  calibration_signals: z.array(
    z.object({
      agent: z.string(),
      expected_confidence: z.number().min(0).max(1),
      outcome_score: z.number().min(0).max(1),
      regime: z.enum(["low_vol", "trend", "high_vol_news"]),
    }),
  ),
});

export const decisionEnvelopeSchema = <T extends z.ZodTypeAny>(payloadSchema: T) =>
  z.object({
    output: payloadSchema,
    decision_rationale: z.string().min(3).max(400),
  });
