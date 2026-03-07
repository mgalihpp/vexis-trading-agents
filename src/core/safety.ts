import type { ExecutionDecision, PortfolioDecision, PortfolioState, ProposalDecision, RiskDecision, RiskRules } from "../types";
import { clamp, round } from "../utils/common";

export const enforceRiskHardGuards = (
  llmRisk: RiskDecision,
  proposal: ProposalDecision,
  portfolio: PortfolioState,
  rules: RiskRules,
  atrPct: number,
  minOrderNotionalUsd?: number,
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
  const stopDistanceFrac = Math.max(proposal.stop_distance_fraction, 1e-9);
  const stopDistancePct = stopDistanceFrac * 100;
  const maxRiskUsd = Math.max(0, rules.maxRiskPerTradeUsd ?? 0);
  const rrMinThreshold = Math.max(0, rules.rrMinThreshold ?? 1.5);
  const riskTolerance = Math.max(1, rules.riskUsdTolerance ?? 1.1);
  const minNotional = Math.max(0, minOrderNotionalUsd ?? 0);
  const notionalByRiskUsd = maxRiskUsd > 0 ? maxRiskUsd / stopDistanceFrac : Number.POSITIVE_INFINITY;
  const targetNotional = Math.max(notionalByRiskUsd, minNotional);
  const impliedRiskUsd = targetNotional * stopDistanceFrac;
  let adjusted = (targetNotional / Math.max(portfolio.equityUsd, 1e-9)) * 100;
  const reasons = [...llmRisk.reasons];
  const binding = [...llmRisk.binding_constraints];

  if (proposal.risk_reward_ratio < rrMinThreshold) {
    adjusted = 0;
    reasons.push(`Hard guard: RR below threshold (${round(proposal.risk_reward_ratio, 3)} < ${round(rrMinThreshold, 3)}).`);
    binding.push("rrMinThreshold");
  }

  if (maxRiskUsd > 0 && impliedRiskUsd > maxRiskUsd * riskTolerance) {
    adjusted = 0;
    reasons.push(
      `Hard guard: implied risk exceeds tolerance (implied=${round(impliedRiskUsd, 4)} > limit=${round(maxRiskUsd * riskTolerance, 4)}).`,
    );
    binding.push("riskUsdTolerance");
  }

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
    adjusted = 0;
    reasons.push("Hard guard: ATR volatility threshold breached.");
    binding.push("maxAtrPct");
  }

  if (portfolio.liquidityUsd < rules.minLiquidityUsd) {
    adjusted = 0;
    reasons.push("Hard guard: liquidity below minimum.");
    binding.push("minLiquidityUsd");
  }

  const approved = adjusted >= 0.2;
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
    approved: approvedNotional > 0,
    approved_notional_usd: round(clamp(approvedNotional, 0, portfolio.equityUsd), 2),
  };
};

export const enforceExecutionHardGuards = (
  executionDecision: ExecutionDecision,
  portfolioDecision: PortfolioDecision,
): ExecutionDecision => {
  if (!portfolioDecision.approved) {
    return {
      execution_venue: "futures",
      portfolio_approved: false,
      executable: false,
      approved_notional_usd: 0,
      risk_budget_usd: executionDecision.risk_budget_usd ?? null,
      effective_risk_usd: executionDecision.effective_risk_usd ?? null,
      required_margin_usd: executionDecision.required_margin_usd ?? null,
      leverage_used: executionDecision.leverage_used ?? null,
      execution_blocker: "portfolio_rejected",
      execution_instructions: null,
      reasons: [...executionDecision.reasons, "Hard guard: portfolio allocation rejected."],
    };
  }

  if (!executionDecision.executable || !executionDecision.execution_instructions) {
    return {
      ...executionDecision,
      execution_venue: "futures",
      portfolio_approved: true,
      executable: false,
      execution_blocker: executionDecision.execution_blocker ?? "execution_not_executable",
      execution_instructions: null,
    };
  }

  return {
    ...executionDecision,
    execution_venue: "futures",
    approved_notional_usd: round(clamp(executionDecision.approved_notional_usd, 0, Number.MAX_SAFE_INTEGER), 2),
    execution_instructions: {
      ...executionDecision.execution_instructions,
      quantity_notional_usd: round(clamp(executionDecision.approved_notional_usd, 0, Number.MAX_SAFE_INTEGER), 2),
    },
  };
};
