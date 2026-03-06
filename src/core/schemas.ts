import { z } from "zod";

export const fundamentalsAnalysisSchema = z.object({
  intrinsic_valuation_bias: z.enum(["undervalued", "fair", "overvalued"]),
  red_flags: z.array(z.string()),
  confidence: z.number().min(0).max(1)
});

export const sentimentAnalysisSchema = z.object({
  sentiment_score: z.number().min(-1).max(1),
  mood: z.enum(["fearful", "neutral", "optimistic"]),
  confidence: z.number().min(0).max(1)
});

export const newsAnalysisSchema = z.object({
  event_impact: z.enum(["bullish", "bearish", "neutral"]),
  affected_sectors: z.array(z.string()),
  severity: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1)
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
    realizedVolatility: z.number().min(0)
  }),
  structure: z.object({
    trend: z.enum(["up", "down", "sideways"]),
    state: z.enum(["bullish", "bearish", "neutral"]),
    bos: z.boolean(),
    choch: z.boolean(),
    swing_high: z.number(),
    swing_low: z.number(),
    support: z.number(),
    resistance: z.number()
  }),
  liquidity: z.object({
    sweep_detected: z.boolean(),
    sweep_side: z.enum(["buy_side", "sell_side", "none"]),
    sweep_score: z.number().min(0).max(1),
    stop_hunt_score: z.number().min(0).max(1)
  }),
  smc: z.object({
    order_blocks: z.array(
      z.object({
        side: z.enum(["demand", "supply"]),
        low: z.number(),
        high: z.number(),
        strength: z.number().min(0).max(1),
        mitigation_count: z.number().min(0),
        age_candles: z.number().min(0)
      })
    ),
    imbalances: z.array(
      z.object({
        side: z.enum(["bullish", "bearish"]),
        low: z.number(),
        high: z.number(),
        gap_size_pct: z.number().min(0),
        fill_probability: z.number().min(0).max(1)
      })
    ),
    smc_score: z.number().min(0).max(1)
  }),
  regime: z.object({
    state: z.enum(["low_vol", "trend", "high_vol_news"]),
    transition_probability: z.number().min(0).max(1),
    volatility_score: z.number().min(0).max(1),
    detection_latency_candles: z.number().min(0)
  }),
  confirmation: z.object({
    orthogonal_score: z.number().min(0).max(1),
    collinearity_risk: z.number().min(0).max(1),
    mtf_alignment_score: z.number().min(0).max(1),
    htf_bias: z.enum(["bullish", "bearish", "neutral"])
  }),
  signals: z.object({
    direction: z.enum(["buy", "sell", "hold"]),
    calibrated_probability: z.number().min(0).max(1),
    confidence_bucket: z.enum(["low", "medium", "high"]),
    composite_score: z.number()
  }),
  shadow: z.object({
    enabled: z.boolean(),
    baseline: z.object({
      trend: z.enum(["up", "down", "sideways"]),
      signal: z.enum(["buy", "sell", "hold"]),
      confidence: z.number().min(0).max(1),
      support: z.number(),
      resistance: z.number()
    }),
    agreement: z.boolean()
  })
});

export const bullishResearchSchema = z.object({
  bullish_arguments: z.array(z.string()),
  reward_estimate_pct: z.number(),
  confidence: z.number().min(0).max(1)
});

export const bearishResearchSchema = z.object({
  bearish_arguments: z.array(z.string()),
  failure_modes: z.array(z.string()),
  confidence: z.number().min(0).max(1)
});

export const debateOutputSchema = z.object({
  bullish_arguments: z.array(z.string()),
  bearish_arguments: z.array(z.string()),
  final_bias: z.enum(["bullish", "bearish", "neutral"]),
  confidence: z.number().min(0).max(1)
});

export const tradeProposalSchema = z.object({
  asset: z.string(),
  side: z.enum(["long", "short"]),
  entry: z.number(),
  stop_loss: z.number(),
  take_profit: z.number(),
  position_size_pct: z.number().min(0),
  timeframe: z.string(),
  reasoning: z.string()
});

export const riskDecisionSchema = z.object({
  approved: z.boolean(),
  adjusted_position_size_pct: z.number().min(0),
  risk_score: z.number().min(0).max(100),
  reasons: z.array(z.string())
});

export const executionDecisionSchema = z.object({
  approve: z.boolean(),
  capital_allocated: z.number().min(0),
  execution_instructions: z
    .object({
      type: z.enum(["market", "limit"]),
      tif: z.enum(["IOC", "GTC"]),
      side: z.enum(["buy", "sell"]),
      quantity_notional_usd: z.number().min(0)
    })
    .nullable(),
  reasons: z.array(z.string())
});

export const decisionEnvelopeSchema = <T extends z.ZodTypeAny>(payloadSchema: T) =>
  z.object({
    output: payloadSchema,
    decision_rationale: z.string().min(3).max(240)
  });
