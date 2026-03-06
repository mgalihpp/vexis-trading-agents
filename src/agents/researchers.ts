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
    const args: string[] = [];

    if (input.fundamentals.intrinsic_valuation_bias === "undervalued") {
      args.push("Valuation appears discounted relative to growth profile.");
    }
    if (input.sentiment.sentiment_score > 0) {
      args.push("Market sentiment leans risk-on.");
    }
    if (input.technical.signals.direction === "buy") {
      args.push("Technical setup aligns with momentum continuation.");
    }
    if (input.news.event_impact !== "bearish") {
      args.push("News flow is not structurally negative.");
    }

    const reward_estimate_pct = round(
      clamp(2 + input.technical.signals.calibrated_probability * 6 + input.sentiment.confidence * 3, 1, 15),
      3
    );

    const output: BullishResearch = {
      bullish_arguments: args,
      reward_estimate_pct,
      confidence: round(clamp(0.35 + args.length * 0.12, 0.2, 0.9), 3)
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
    const bearish_arguments: string[] = [];
    const failure_modes: string[] = [];

    if (input.fundamentals.red_flags.length > 0) {
      bearish_arguments.push("Balance-sheet and quality red flags remain unresolved.");
      failure_modes.push("Fundamental deterioration triggers repricing.");
    }
    if (input.news.event_impact === "bearish") {
      bearish_arguments.push("Negative event cluster increases downside tail risk.");
      failure_modes.push("Policy headline shock drives gap-down move.");
    }
    if (input.technical.signals.direction === "sell") {
      bearish_arguments.push("Momentum profile warns of trend exhaustion.");
      failure_modes.push("Support breach accelerates liquidations.");
    }
    if (input.sentiment.mood === "fearful") {
      bearish_arguments.push("Sentiment regime indicates fragile demand.");
      failure_modes.push("Risk-off flow suppresses rebounds.");
    }

    const output: BearishResearch = {
      bearish_arguments,
      failure_modes,
      confidence: round(clamp(0.3 + bearish_arguments.length * 0.14, 0.2, 0.9), 3)
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
    const bullishScore = input.bullish.bullish_arguments.length * 0.2 + input.bullish.confidence;
    const bearishScore = input.bearish.bearish_arguments.length * 0.2 + input.bearish.confidence;
    const diff = bullishScore - bearishScore;

    const final_bias = diff > 0.2 ? "bullish" : diff < -0.2 ? "bearish" : "neutral";

    const output: DebateOutput = {
      bullish_arguments: input.bullish.bullish_arguments,
      bearish_arguments: input.bearish.bearish_arguments,
      final_bias,
      confidence: round(clamp(0.45 + Math.abs(diff) * 0.2, 0.2, 0.95), 3)
    };

    await this.logDecision(ctx, input, output, "Compared weighted thesis strength and synthesized a single portfolio bias.");
    return output;
  }
}
