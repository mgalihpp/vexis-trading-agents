import type {
  AgentContext,
  EventStore,
  PortfolioState,
  ProposalDecision,
  RiskDecision,
  RiskRules,
} from "../types";
import { clamp, round } from "../utils/common";
import { BaseAgent } from "./base";

export interface RiskInput {
  proposal: ProposalDecision;
  portfolio: PortfolioState;
  rules: RiskRules;
  atrPct: number;
  regimeState?: "low_vol" | "trend" | "high_vol_news";
  calibratedProbability?: number;
}

export class RiskManager extends BaseAgent<RiskInput, RiskDecision> {
  public readonly name = "RiskManager";

  public constructor(eventStore: EventStore) {
    super(eventStore);
  }

  public async run(input: RiskInput, ctx: AgentContext): Promise<RiskDecision> {
    if (input.proposal.proposal_type === "no_trade") {
      const output: RiskDecision = {
        action: "reject",
        approved: false,
        approved_position_size_pct_equity: 0,
        risk_score_raw: 0,
        risk_score_normalized: 0,
        risk_band: "low",
        evaluation_state: "not_applicable",
        binding_constraints: ["no_trade_abstain"],
        reasons: input.proposal.reasons,
      };
      await this.logDecision(ctx, input, output, "Risk evaluation skipped because proposal is explicit no-trade.");
      return output;
    }
    const reasons: string[] = [];
    const binding: string[] = [];

    const stopDistancePct = Math.abs(input.proposal.entry - input.proposal.stop_loss) / Math.max(input.proposal.entry, 1e-9) * 100;
    const maxSizeByRisk = input.rules.maxRiskPerTradePct / Math.max(stopDistancePct, 0.0001);
    let approvedSize = Math.min(input.proposal.suggested_position_size_pct_equity, maxSizeByRisk);

    if (input.portfolio.currentExposurePct + approvedSize > input.rules.maxExposurePct) {
      approvedSize = Math.max(0, input.rules.maxExposurePct - input.portfolio.currentExposurePct);
      reasons.push("Adjusted for max exposure limit.");
      binding.push("maxExposurePct");
    }

    if (input.portfolio.currentDrawdownPct >= input.rules.drawdownCutoffPct) {
      approvedSize = 0;
      reasons.push("Drawdown cutoff reached.");
      binding.push("drawdownCutoffPct");
    }

    if (input.atrPct > input.rules.maxAtrPct) {
      approvedSize *= 0.5;
      reasons.push("Volatility above ATR threshold.");
      binding.push("maxAtrPct");
    }

    if (input.regimeState === "high_vol_news") {
      approvedSize *= 0.6;
      reasons.push("Regime high_vol_news: reduced size for tail-risk control.");
      binding.push("regimeHardening");
    }

    if ((input.calibratedProbability ?? 0.5) < 0.45) {
      approvedSize *= 0.7;
      reasons.push("Low calibrated technical probability.");
      binding.push("probabilityQuality");
    }

    if (input.portfolio.liquidityUsd < input.rules.minLiquidityUsd) {
      approvedSize = 0;
      reasons.push("Liquidity constraint violated.");
      binding.push("minLiquidityUsd");
    }

    const approved = approvedSize >= 0.2;
    const action = approved ? (approvedSize < input.proposal.suggested_position_size_pct_equity ? "reduce" : "approve") : "reject";
    if (!approved && reasons.length === 0) {
      reasons.push("Position size below minimum threshold after risk normalization.");
    }

    const raw = round(
      clamp(
        stopDistancePct * 6 + input.atrPct * 1.5 + (approved ? 8 : 28),
        0,
        100,
      ),
      4,
    );
    const normalized = round(clamp(raw / 100, 0, 1), 4);
    const band = normalized >= 0.8
      ? "high"
      : normalized >= 0.65
        ? "medium_high"
        : normalized >= 0.4
          ? "medium"
          : "low";

    const output: RiskDecision = {
      action,
      approved,
      approved_position_size_pct_equity: round(clamp(approvedSize, 0, input.rules.maxExposurePct), 3),
      risk_score_raw: raw,
      risk_score_normalized: normalized,
      risk_band: band,
      evaluation_state: "evaluated",
      binding_constraints: binding,
      reasons,
    };

    await this.logDecision(ctx, input, output, "Risk admissibility only: normalized size, evaluated constraints, and assigned risk band.");
    return output;
  }
}
