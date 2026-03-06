import type {
  AgentContext,
  EventStore,
  PortfolioState,
  RiskDecision,
  RiskRules,
  TradeProposal
} from "../types";
import { clamp, round } from "../utils/common";
import { BaseAgent } from "./base";

export interface RiskInput {
  proposal: TradeProposal;
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
    const reasons: string[] = [];

    const stopDistancePct = Math.abs(input.proposal.entry - input.proposal.stop_loss) / input.proposal.entry * 100;
    const maxSizeByRisk = input.rules.maxRiskPerTradePct / Math.max(stopDistancePct, 0.0001);
    let adjustedSize = Math.min(input.proposal.position_size_pct, maxSizeByRisk);

    if (input.portfolio.currentExposurePct + adjustedSize > input.rules.maxExposurePct) {
      adjustedSize = Math.max(0, input.rules.maxExposurePct - input.portfolio.currentExposurePct);
      reasons.push("Adjusted for max exposure limit.");
    }

    if (input.portfolio.currentDrawdownPct >= input.rules.drawdownCutoffPct) {
      adjustedSize = 0;
      reasons.push("Drawdown cutoff reached.");
    }

    if (input.atrPct > input.rules.maxAtrPct) {
      adjustedSize *= 0.5;
      reasons.push("Volatility above ATR threshold.");
    }

    if (input.regimeState === "high_vol_news") {
      adjustedSize *= 0.6;
      reasons.push("Regime high_vol_news: reduced size for tail-risk control.");
    }

    if ((input.calibratedProbability ?? 0.5) < 0.45) {
      adjustedSize *= 0.7;
      reasons.push("Low calibrated technical probability.");
    }

    if (input.portfolio.liquidityUsd < input.rules.minLiquidityUsd) {
      adjustedSize = 0;
      reasons.push("Liquidity constraint violated.");
    }

    const approved = adjustedSize >= 0.25;
    if (!approved && reasons.length === 0) {
      reasons.push("Position size below minimum threshold after risk normalization.");
    }

    const risk_score = round(
      clamp(
        stopDistancePct * 8 + input.atrPct * 2 + (approved ? 10 : 30),
        0,
        100
      ),
      3
    );

    const output: RiskDecision = {
      approved,
      adjusted_position_size_pct: round(clamp(adjustedSize, 0, input.rules.maxExposurePct), 3),
      risk_score,
      reasons
    };

    await this.logDecision(ctx, input, output, "Applied trade risk, portfolio limits, drawdown, volatility and liquidity guards.");
    return output;
  }
}
