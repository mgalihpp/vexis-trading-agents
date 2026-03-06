import type {
  AgentContext,
  AnalystBundle,
  DebateOutput,
  EventStore,
  TradeProposal
} from "../types";
import { clamp, round } from "../utils/common";
import { BaseAgent } from "./base";

export interface TraderInput {
  asset: string;
  lastPrice: number;
  analysts: AnalystBundle;
  debate: DebateOutput;
}

export class TraderAgent extends BaseAgent<TraderInput, TradeProposal> {
  public readonly name = "TraderAgent";

  public constructor(eventStore: EventStore) {
    super(eventStore);
  }

  public async run(input: TraderInput, ctx: AgentContext): Promise<TradeProposal> {
    const primaryDirection = input.analysts.technical.signals.direction;
    const side = primaryDirection === "sell" || input.debate.final_bias === "bearish" ? "short" : "long";
    const atr = input.analysts.technical.features.atr14 || input.lastPrice * 0.01;
    const entry = round(input.lastPrice, 4);
    const stopDistance = round(atr * 1.2, 4);

    const stop_loss = side === "long" ? round(entry - stopDistance, 4) : round(entry + stopDistance, 4);
    const take_profit = side === "long" ? round(entry + stopDistance * 2.2, 4) : round(entry - stopDistance * 2.2, 4);

    const conviction = (input.analysts.technical.signals.calibrated_probability + input.debate.confidence) / 2;
    const position_size_pct = round(clamp(2 + conviction * 6, 0.5, 10), 3);

    const output: TradeProposal = {
      asset: input.asset,
      side,
      entry,
      stop_loss,
      take_profit,
      position_size_pct,
      timeframe: "1h",
      reasoning: `bias=${input.debate.final_bias}; tech_v2=${input.analysts.technical.signals.direction}; conf=${input.analysts.technical.signals.confidence_bucket}; sentiment=${input.analysts.sentiment.mood}`
    };

    await this.logDecision(ctx, input, output, "Converted debate bias and ATR-based risk framing into executable trade parameters.");
    return output;
  }
}
