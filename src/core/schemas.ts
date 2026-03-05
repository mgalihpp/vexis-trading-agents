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
  indicators: z.object({
    rsi: z.number(),
    macd: z.number(),
    macdSignal: z.number(),
    emaFast: z.number(),
    emaSlow: z.number(),
    atr: z.number()
  }),
  trend: z.enum(["up", "down", "sideways"]),
  signal: z.enum(["buy", "sell", "hold"]),
  key_levels: z.object({
    support: z.number(),
    resistance: z.number()
  }),
  confidence: z.number().min(0).max(1)
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
