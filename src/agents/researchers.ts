import type {
  AnalystBundle,
  BearishResearch,
  BullishResearch,
  ConfidenceVector,
  DebateOutput,
  EventStore,
  AgentContext,
} from "../types";
import { clamp, round } from "../utils/common";
import { BaseAgent } from "./base";

const buildConfidence = (
  signal: number,
  data: number,
  reliability: number,
): ConfidenceVector => ({
  signal_confidence: round(clamp(signal, 0, 1), 4),
  data_quality_confidence: round(clamp(data, 0, 1), 4),
  model_reliability: round(clamp(reliability, 0, 1), 4),
  effective_confidence: round(clamp(signal * 0.5 + data * 0.2 + reliability * 0.3, 0, 1), 4),
});

export class BullishResearcher extends BaseAgent<AnalystBundle, BullishResearch> {
  public readonly name = "BullishResearcher";

  public constructor(eventStore: EventStore) {
    super(eventStore);
  }

  public async run(input: AnalystBundle, ctx: AgentContext): Promise<BullishResearch> {
    const thesis: string[] = [];
    const invalidationTriggers: string[] = [];

    if (input.fundamentals.intrinsic_valuation_bias === "undervalued") {
      thesis.push("Valuation appears discounted relative to growth profile.");
    } else if (input.fundamentals.intrinsic_valuation_bias === "overvalued") {
      invalidationTriggers.push("Overvaluation risk can cap upside follow-through.");
    }
    if (input.sentiment.sentiment_score > 0) {
      thesis.push("Market sentiment leans risk-on.");
    } else if (input.sentiment.sentiment_score < 0) {
      invalidationTriggers.push("Sentiment reversal can invalidate bullish continuation.");
    }
    if (input.technical.signals.direction === "buy") {
      thesis.push("Technical setup aligns with momentum continuation.");
    } else if (input.technical.signals.direction === "sell") {
      invalidationTriggers.push("Momentum breakdown can trigger downside acceleration.");
    }
    if (input.news.event_impact !== "bearish") {
      thesis.push("News flow is not structurally negative.");
    } else {
      invalidationTriggers.push("Bearish headline shocks can break bullish thesis.");
    }

    const expectedMovePct = round(
      clamp(2 + input.technical.signals.calibrated_probability * 6 + input.sentiment.confidence.effective_confidence * 3, 1, 15),
      3,
    );

    const output: BullishResearch = {
      thesis,
      expected_move_pct: expectedMovePct,
      time_horizon: "intraday",
      invalidation_triggers: invalidationTriggers,
      confidence: buildConfidence(
        clamp(0.35 + thesis.length * 0.12, 0.2, 0.9),
        input.data_quality.provider_health_score,
        clamp((input.technical.signals.confidence.model_reliability + input.sentiment.confidence.model_reliability) / 2, 0, 1),
      ),
    };

    await this.logDecision(ctx, input, output, "Built upside thesis from valuation, sentiment, technicals and event backdrop.");
    return output;
  }
}

export class BearishResearcher extends BaseAgent<AnalystBundle, BearishResearch> {
  public readonly name = "BearishResearcher";

  public constructor(eventStore: EventStore) {
    super(eventStore);
  }

  public async run(input: AnalystBundle, ctx: AgentContext): Promise<BearishResearch> {
    const thesis: string[] = [];
    const invalidationTriggers: string[] = [];

    if (input.fundamentals.red_flags.length > 0) {
      thesis.push("Balance-sheet and quality red flags remain unresolved.");
      invalidationTriggers.push("Fundamental deterioration triggers repricing.");
    }
    if (input.news.event_impact === "bearish") {
      thesis.push("Negative event cluster increases downside tail risk.");
      invalidationTriggers.push("Policy headline shock drives gap-down move.");
    }
    if (input.technical.signals.direction === "sell") {
      thesis.push("Momentum profile warns of trend exhaustion.");
      invalidationTriggers.push("Support breach accelerates liquidations.");
    }
    if (input.sentiment.mood === "fearful") {
      thesis.push("Sentiment regime indicates fragile demand.");
      invalidationTriggers.push("Risk-off flow suppresses rebounds.");
    }

    const expectedMovePct = round(
      clamp(2 + input.technical.signals.calibrated_probability * 6 + input.sentiment.confidence.effective_confidence * 3, 1, 15),
      3,
    );

    const output: BearishResearch = {
      thesis,
      expected_move_pct: expectedMovePct,
      time_horizon: "intraday",
      invalidation_triggers: invalidationTriggers,
      confidence: buildConfidence(
        clamp(0.3 + thesis.length * 0.14, 0.2, 0.9),
        input.data_quality.provider_health_score,
        clamp((input.technical.signals.confidence.model_reliability + input.news.confidence.model_reliability) / 2, 0, 1),
      ),
    };

    await this.logDecision(ctx, input, output, "Stress-tested assumptions and enumerated principal downside failure modes.");
    return output;
  }
}

export class DebateSynthesizer extends BaseAgent<{ bullish: BullishResearch; bearish: BearishResearch }, DebateOutput> {
  public readonly name = "DebateSynthesizer";

  public constructor(eventStore: EventStore) {
    super(eventStore);
  }

  public async run(
    input: { bullish: BullishResearch; bearish: BearishResearch },
    ctx: AgentContext,
  ): Promise<DebateOutput> {
    const bullishScore = input.bullish.thesis.length * 0.2 + input.bullish.confidence.effective_confidence;
    const bearishScore = input.bearish.thesis.length * 0.2 + input.bearish.confidence.effective_confidence;
    const diff = bullishScore - bearishScore;

    const finalBias = diff > 0.2 ? "bullish" : diff < -0.2 ? "bearish" : "neutral";
    const expectedMove = round(
      finalBias === "bullish"
        ? input.bullish.expected_move_pct
        : finalBias === "bearish"
          ? input.bearish.expected_move_pct
          : 0,
      3,
    );
    const decisionStability = Math.abs(diff) > 0.55 ? "high" : Math.abs(diff) > 0.25 ? "medium" : "low";

    const output: DebateOutput = {
      bullish_thesis: input.bullish.thesis,
      bearish_thesis: input.bearish.thesis,
      final_bias: finalBias,
      dominant_horizon: finalBias === "neutral" ? "intraday" : (finalBias === "bullish" ? input.bullish.time_horizon : input.bearish.time_horizon),
      expected_move_pct: expectedMove,
      key_disagreement: finalBias === "neutral"
        ? "Bull and bear thesis strength are balanced."
        : "Direction confidence diverges between opposing thesis.",
      must_monitor_conditions: [
        ...input.bullish.invalidation_triggers.slice(0, 2),
        ...input.bearish.invalidation_triggers.slice(0, 2),
      ],
      invalidation_triggers: finalBias === "bullish"
        ? input.bullish.invalidation_triggers
        : finalBias === "bearish"
          ? input.bearish.invalidation_triggers
          : [...input.bullish.invalidation_triggers, ...input.bearish.invalidation_triggers],
      decision_stability: decisionStability,
      confidence: buildConfidence(
        clamp(0.45 + Math.abs(diff) * 0.2, 0.2, 0.95),
        clamp((input.bullish.confidence.data_quality_confidence + input.bearish.confidence.data_quality_confidence) / 2, 0, 1),
        clamp((input.bullish.confidence.model_reliability + input.bearish.confidence.model_reliability) / 2, 0, 1),
      ),
    };

    await this.logDecision(ctx, input, output, "Compared weighted thesis strength and synthesized a structured portfolio bias.");
    return output;
  }
}
