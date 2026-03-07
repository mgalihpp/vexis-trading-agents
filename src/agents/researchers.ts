import type {
  AnalystBundle,
  BearishResearch,
  BullishResearch,
  DebateOutput,
  EventStore,
  AgentContext
} from "../types";
import { clamp, round } from "../utils/common";
import { BaseAgent } from "./base";

export class BullishResearcher extends BaseAgent<AnalystBundle, BullishResearch> {
  public readonly name = "BullishResearcher";

  public constructor(eventStore: EventStore) {
    super(eventStore);
  }

  public async run(input: AnalystBundle, ctx: AgentContext): Promise<BullishResearch> {
    const argumentsList: string[] = [];
    const failureModes: string[] = [];

    if (input.fundamentals.intrinsic_valuation_bias === "undervalued") {
      argumentsList.push("Valuation appears discounted relative to growth profile.");
    } else if (input.fundamentals.intrinsic_valuation_bias === "overvalued") {
      failureModes.push("Overvaluation risk can cap upside follow-through.");
    }
    if (input.sentiment.sentiment_score > 0) {
      argumentsList.push("Market sentiment leans risk-on.");
    } else if (input.sentiment.sentiment_score < 0) {
      failureModes.push("Sentiment reversal can invalidate bullish continuation.");
    }
    if (input.technical.signals.direction === "buy") {
      argumentsList.push("Technical setup aligns with momentum continuation.");
    } else if (input.technical.signals.direction === "sell") {
      failureModes.push("Momentum breakdown can trigger downside acceleration.");
    }
    if (input.news.event_impact !== "bearish") {
      argumentsList.push("News flow is not structurally negative.");
    } else {
      failureModes.push("Bearish headline shocks can break bullish thesis.");
    }

    const riskOrRewardEstimatePct = round(
      clamp(2 + input.technical.signals.calibrated_probability * 6 + input.sentiment.confidence * 3, 1, 15),
      3
    );

    const output: BullishResearch = {
      arguments: argumentsList,
      risk_or_reward_estimate_pct: riskOrRewardEstimatePct,
      failure_modes: failureModes,
      confidence: round(clamp(0.35 + argumentsList.length * 0.12, 0.2, 0.9), 3)
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
    const argumentsList: string[] = [];
    const failureModes: string[] = [];

    if (input.fundamentals.red_flags.length > 0) {
      argumentsList.push("Balance-sheet and quality red flags remain unresolved.");
      failureModes.push("Fundamental deterioration triggers repricing.");
    }
    if (input.news.event_impact === "bearish") {
      argumentsList.push("Negative event cluster increases downside tail risk.");
      failureModes.push("Policy headline shock drives gap-down move.");
    }
    if (input.technical.signals.direction === "sell") {
      argumentsList.push("Momentum profile warns of trend exhaustion.");
      failureModes.push("Support breach accelerates liquidations.");
    }
    if (input.sentiment.mood === "fearful") {
      argumentsList.push("Sentiment regime indicates fragile demand.");
      failureModes.push("Risk-off flow suppresses rebounds.");
    }

    const riskOrRewardEstimatePct = round(
      clamp(2 + input.technical.signals.calibrated_probability * 6 + input.sentiment.confidence * 3, 1, 15),
      3
    );

    const output: BearishResearch = {
      arguments: argumentsList,
      risk_or_reward_estimate_pct: riskOrRewardEstimatePct,
      failure_modes: failureModes,
      confidence: round(clamp(0.3 + argumentsList.length * 0.14, 0.2, 0.9), 3)
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
    ctx: AgentContext
  ): Promise<DebateOutput> {
    const bullishScore = input.bullish.arguments.length * 0.2 + input.bullish.confidence;
    const bearishScore = input.bearish.arguments.length * 0.2 + input.bearish.confidence;
    const diff = bullishScore - bearishScore;

    const final_bias = diff > 0.2 ? "bullish" : diff < -0.2 ? "bearish" : "neutral";

    const output: DebateOutput = {
      bullish_arguments: input.bullish.arguments,
      bearish_arguments: input.bearish.arguments,
      final_bias,
      confidence: round(clamp(0.45 + Math.abs(diff) * 0.2, 0.2, 0.95), 3)
    };

    await this.logDecision(ctx, input, output, "Compared weighted thesis strength and synthesized a single portfolio bias.");
    return output;
  }
}
