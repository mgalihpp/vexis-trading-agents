import type {
  AgentContext,
  AnalystBundle,
  ConfidenceVector,
  DebateOutput,
  EventStore,
  ProposalDecision,
  RiskRules,
} from "../types";
import { clamp, round } from "../utils/common";
import { BaseAgent } from "./base";

export interface TraderInput {
  asset: string;
  lastPrice: number;
  inputTimeframe: string;
  analysts: AnalystBundle;
  debate: DebateOutput;
  riskRules?: RiskRules;
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

const normalizeSplit = (split: number[] | undefined): number[] => {
  if (!split || split.length === 0) return [50, 30, 20];
  const positive = split.map((v) => Math.max(0, v));
  const total = positive.reduce((acc, v) => acc + v, 0);
  if (total <= 0) return [50, 30, 20];
  return positive.map((v) => round((v / total) * 100, 4));
};

const weightedRr = (rrTargets: number[], splitPct: number[]): number => {
  if (rrTargets.length === 0 || splitPct.length === 0) return 0;
  const w = splitPct.map((v) => v / 100);
  const len = Math.min(rrTargets.length, w.length);
  let out = 0;
  for (let i = 0; i < len; i += 1) out += rrTargets[i] * w[i];
  return out;
};

export class TraderAgent extends BaseAgent<TraderInput, ProposalDecision> {
  public readonly name = "TraderAgent";

  public constructor(eventStore: EventStore) {
    super(eventStore);
  }

  public async run(input: TraderInput, ctx: AgentContext): Promise<ProposalDecision> {
    const primaryDirection = input.analysts.technical.signals.direction;
    const side = primaryDirection === "sell" || input.debate.final_bias === "bearish" ? "short" : "long";
    const atr = input.analysts.technical.features.atr14 || input.lastPrice * 0.01;
    const entry = round(input.lastPrice, 4);
    const splitPct = normalizeSplit(input.riskRules?.tpPartialSplit);
    const rrMinThreshold = Math.max(0, input.riskRules?.rrMinThreshold ?? 1.5);

    const structureSupport = input.analysts.technical.structure.support;
    const structureResistance = input.analysts.technical.structure.resistance;
    const structureBuffer = atr * 0.1;
    const atrStopDistance = round(atr * 1.2, 4);

    const stopLoss = side === "long"
      ? round(Math.min(entry - atrStopDistance, structureSupport - structureBuffer), 4)
      : round(Math.max(entry + atrStopDistance, structureResistance + structureBuffer), 4);
    const riskDistance = Math.max(Math.abs(entry - stopLoss), 1e-9);

    const fixedTargets = side === "long"
      ? [round(entry + riskDistance, 4), round(entry + riskDistance * 2, 4), round(entry + riskDistance * 3, 4)]
      : [round(entry - riskDistance, 4), round(entry - riskDistance * 2, 4), round(entry - riskDistance * 3, 4)];

    const structureBaseDistance = side === "long"
      ? Math.max(structureResistance - entry, 0)
      : Math.max(entry - structureSupport, 0);
    const structureTargets = structureBaseDistance > 0
      ? side === "long"
        ? [
            round(entry + structureBaseDistance, 4),
            round(entry + structureBaseDistance * 2, 4),
            round(entry + structureBaseDistance * 3, 4),
          ]
        : [
            round(entry - structureBaseDistance, 4),
            round(entry - structureBaseDistance * 2, 4),
            round(entry - structureBaseDistance * 3, 4),
          ]
      : [];

    const rrFor = (targets: number[]): number[] => targets.map((tp) => Math.abs(tp - entry) / riskDistance);
    const fixedRr = rrFor(fixedTargets);
    const structureRr = rrFor(structureTargets);
    const structureValid = structureTargets.length === 3 && weightedRr(structureRr, splitPct) >= rrMinThreshold;

    const takeProfitTargets = structureValid ? structureTargets : fixedTargets;
    const rrTargets = rrFor(takeProfitTargets);
    const rr = weightedRr(rrTargets, splitPct);
    const stopDistancePct = Math.abs(entry - stopLoss) / Math.max(entry, 1e-9) * 100;
    const tpDistancePct = Math.abs(takeProfitTargets[0] - entry) / Math.max(entry, 1e-9) * 100;

    if (rr < rrMinThreshold) {
      const noTrade: ProposalDecision = {
        proposal_type: "no_trade",
        asset: input.asset,
        input_timeframe: input.inputTimeframe,
        decision_horizon: input.debate.dominant_horizon,
        reasons: [
          `RR gate rejected: weighted_rr=${round(rr, 3)} < rr_min_threshold=${round(rrMinThreshold, 3)}`,
        ],
        must_monitor_conditions: input.debate.must_monitor_conditions,
        confidence: input.debate.confidence,
      };
      await this.logDecision(ctx, input, noTrade, "Rejected in trader node due to RR threshold gate.");
      return noTrade;
    }

    const conviction = (input.analysts.technical.signals.confidence.effective_confidence + input.debate.confidence.effective_confidence) / 2;
    const suggestedSize = round(clamp(1 + conviction * 4, 0.2, 6), 3);
    const leverage = Math.max(1, Math.floor(input.riskRules?.futuresMaxLeverage ?? 5));

    const output: ProposalDecision = {
      proposal_type: "trade",
      asset: input.asset,
      side,
      execution_venue: "futures",
      leverage,
      entry,
      stop_loss: stopLoss,
      take_profit_targets: takeProfitTargets,
      tp_partial_close_pct: splitPct,
      move_stop_to_breakeven_after_tp1: input.riskRules?.tpBreakevenAfterTp1 ?? true,
      suggested_position_size_pct_equity: suggestedSize,
      input_timeframe: input.inputTimeframe,
      decision_horizon: input.debate.dominant_horizon,
      expected_holding_period_hours: input.debate.dominant_horizon === "intraday" ? 6 : input.debate.dominant_horizon === "swing" ? 24 : 2,
      risk_reward_ratio: round(rr, 3),
      stop_distance_pct: round(stopDistancePct, 3),
      stop_distance_fraction: round(stopDistancePct / 100, 6),
      take_profit_distance_pct: round(tpDistancePct, 3),
      structural_invalidation_level: input.analysts.technical.structure.resistance,
      thesis: [
        ...(input.debate.final_bias === "bearish"
          ? input.debate.bearish_thesis.slice(0, 2)
          : input.debate.bullish_thesis.slice(0, 2)),
        `technical_direction=${input.analysts.technical.signals.direction}`,
      ],
      entry_rationale: `Enter at market near current price with debate bias=${input.debate.final_bias}.`,
      stop_loss_rationale: "Stop uses structure-aware placement with ATR buffer fallback.",
      take_profit_rationale: structureValid
        ? "Targets use structure/liquidity levels that satisfy RR gate."
        : "Targets use fixed R multiples (1R/2R/3R).",
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
