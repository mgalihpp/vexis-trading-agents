import type { ExecutionDecision, PortfolioDecision, PortfolioState, ProposalDecision, RiskDecision, RiskRules } from "../types";
import { clamp, round } from "../utils/common";

export const enforceRiskHardGuards = (
  llmRisk: RiskDecision,
  proposal: ProposalDecision,
  portfolio: PortfolioState,
  rules: RiskRules,
  atrPct: number,
): RiskDecision => {
  if (proposal.proposal_type === "no_trade") {
    return {
      action: "reject",
      approved: false,
      approved_position_size_pct_equity: 0,
      risk_score_raw: 0,
      risk_score_normalized: 0,
      risk_band: "low",
      evaluation_state: "not_applicable",
      binding_constraints: ["no_trade_abstain"],
      reasons: proposal.reasons,
    };
  }
  const stopDistancePct = Math.abs(proposal.entry - proposal.stop_loss) / Math.max(proposal.entry, 0.0001) * 100;
  const maxSizeByRisk = rules.maxRiskPerTradePct / Math.max(stopDistancePct, 0.0001);
  let adjusted = Math.min(llmRisk.approved_position_size_pct_equity, maxSizeByRisk);
  const reasons = [...llmRisk.reasons];
  const binding = [...llmRisk.binding_constraints];

  if (portfolio.currentExposurePct + adjusted > rules.maxExposurePct) {
    adjusted = Math.max(0, rules.maxExposurePct - portfolio.currentExposurePct);
    reasons.push("Hard guard: max exposure exceeded.");
    binding.push("maxExposurePct");
  }

  if (portfolio.currentDrawdownPct >= rules.drawdownCutoffPct) {
    adjusted = 0;
    reasons.push("Hard guard: drawdown cutoff reached.");
    binding.push("drawdownCutoffPct");
  }

  if (atrPct > rules.maxAtrPct) {
    adjusted *= 0.5;
    reasons.push("Hard guard: ATR volatility threshold breached.");
    binding.push("maxAtrPct");
  }

  if (portfolio.liquidityUsd < rules.minLiquidityUsd) {
    adjusted = 0;
    reasons.push("Hard guard: liquidity below minimum.");
    binding.push("minLiquidityUsd");
  }

  const approved = llmRisk.approved && adjusted >= 0.2;
  const scoreRaw = Math.max(llmRisk.risk_score_raw, stopDistancePct * 8 + atrPct * 2);
  const scoreNorm = round(clamp(scoreRaw / 100, 0, 1), 4);
  const band = scoreNorm >= 0.8 ? "high" : scoreNorm >= 0.65 ? "medium_high" : scoreNorm >= 0.4 ? "medium" : "low";
  return {
    action: approved ? (adjusted < proposal.suggested_position_size_pct_equity ? "reduce" : "approve") : "reject",
    approved,
    approved_position_size_pct_equity: round(clamp(adjusted, 0, rules.maxExposurePct), 3),
    risk_score_raw: round(clamp(scoreRaw, 0, 100), 3),
    risk_score_normalized: scoreNorm,
    risk_band: band,
    evaluation_state: "evaluated",
    binding_constraints: binding,
    reasons,
  };
};

export const enforcePortfolioHardGuards = (
  portfolioDecision: PortfolioDecision,
  risk: RiskDecision,
  portfolio: PortfolioState,
): PortfolioDecision => {
  if (!risk.approved) {
    return {
      approved: false,
      approved_position_size_pct_equity: 0,
      approved_notional_usd: 0,
      concentration_check: "not_applicable",
      correlation_check: "not_applicable",
      reserve_cash_check: "not_applicable",
      reasons: [...portfolioDecision.reasons, "Hard guard: risk gate rejected proposal."],
    };
  }
  const maxCapital = portfolio.equityUsd * (risk.approved_position_size_pct_equity / 100);
  const approvedNotional = Math.min(maxCapital, portfolioDecision.approved_notional_usd);
  return {
    ...portfolioDecision,
    approved: portfolioDecision.approved && approvedNotional > 0,
    approved_notional_usd: round(clamp(approvedNotional, 0, portfolio.equityUsd), 2),
  };
};

export const enforceExecutionHardGuards = (
  executionDecision: ExecutionDecision,
  portfolioDecision: PortfolioDecision,
): ExecutionDecision => {
  if (!portfolioDecision.approved) {
    return {
      portfolio_approved: false,
      executable: false,
      approved_notional_usd: 0,
      execution_blocker: "portfolio_rejected",
      execution_instructions: null,
      reasons: [...executionDecision.reasons, "Hard guard: portfolio allocation rejected."],
    };
  }

  if (!executionDecision.executable || !executionDecision.execution_instructions) {
    return {
      ...executionDecision,
      portfolio_approved: true,
      executable: false,
      execution_blocker: executionDecision.execution_blocker ?? "execution_not_executable",
      execution_instructions: null,
    };
  }

  return {
    ...executionDecision,
    approved_notional_usd: round(clamp(executionDecision.approved_notional_usd, 0, portfolioDecision.approved_notional_usd), 2),
    execution_instructions: {
      ...executionDecision.execution_instructions,
      quantity_notional_usd: round(clamp(executionDecision.approved_notional_usd, 0, portfolioDecision.approved_notional_usd), 2),
    },
  };
};
