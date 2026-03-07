import type {
  AgentContext,
  AnalystBundle,
  ConfidenceVector,
  DebateOutput,
  EventStore,
  TradeProposal,
} from "../types";
import { clamp, round } from "../utils/common";
import { BaseAgent } from "./base";

export interface TraderInput {
  asset: string;
  lastPrice: number;
  inputTimeframe: string;
  analysts: AnalystBundle;
  debate: DebateOutput;
}

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

    const stopLoss = side === "long" ? round(entry - stopDistance, 4) : round(entry + stopDistance, 4);
    const takeProfit = side === "long" ? round(entry + stopDistance * 2.2, 4) : round(entry - stopDistance * 2.2, 4);
    const rr = Math.abs(takeProfit - entry) / Math.max(Math.abs(entry - stopLoss), 1e-9);
    const stopDistancePct = Math.abs(entry - stopLoss) / Math.max(entry, 1e-9) * 100;
    const tpDistancePct = Math.abs(takeProfit - entry) / Math.max(entry, 1e-9) * 100;

    const conviction = (input.analysts.technical.signals.confidence.effective_confidence + input.debate.confidence.effective_confidence) / 2;
    const suggestedSize = round(clamp(1 + conviction * 4, 0.2, 6), 3);

    const output: TradeProposal = {
      proposal_type: "trade",
      asset: input.asset,
      side,
      entry,
      stop_loss: stopLoss,
      take_profit_targets: [takeProfit],
      suggested_position_size_pct_equity: suggestedSize,
      input_timeframe: input.inputTimeframe,
      decision_horizon: input.debate.dominant_horizon,
      expected_holding_period_hours: input.debate.dominant_horizon === "intraday" ? 6 : input.debate.dominant_horizon === "swing" ? 24 : 2,
      risk_reward_ratio: round(rr, 3),
      stop_distance_pct: round(stopDistancePct, 3),
      take_profit_distance_pct: round(tpDistancePct, 3),
      structural_invalidation_level: input.analysts.technical.structure.resistance,
      thesis: [
        ...(input.debate.final_bias === "bearish"
          ? input.debate.bearish_thesis.slice(0, 2)
          : input.debate.bullish_thesis.slice(0, 2)),
        `technical_direction=${input.analysts.technical.signals.direction}`,
      ],
      entry_rationale: `Enter at market near current price with debate bias=${input.debate.final_bias}.`,
      stop_loss_rationale: "Stop is ATR-based and aligned to structural invalidation level.",
      take_profit_rationale: "Primary target uses >=2R distance from entry.",
      invalid_if: input.debate.invalidation_triggers,
      confidence: buildConfidence(
        conviction,
        input.analysts.data_quality.provider_health_score,
        clamp(
          (input.analysts.technical.signals.confidence.model_reliability + input.debate.confidence.model_reliability) / 2,
          0,
          1,
        ),
      ),
    };

    await this.logDecision(ctx, input, output, "Constructed proposal only (no final sizing authority) from debate+technical context.");
    return output;
  }
}
