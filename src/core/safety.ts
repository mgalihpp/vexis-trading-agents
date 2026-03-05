import type { ExecutionDecision, PortfolioState, RiskDecision, RiskRules, TradeProposal } from "../types";
import { clamp, round } from "../utils/common";

export const enforceRiskHardGuards = (
  llmRisk: RiskDecision,
  proposal: TradeProposal,
  portfolio: PortfolioState,
  rules: RiskRules,
  atrPct: number
): RiskDecision => {
  const stopDistancePct = Math.abs(proposal.entry - proposal.stop_loss) / Math.max(proposal.entry, 0.0001) * 100;
  const maxSizeByRisk = rules.maxRiskPerTradePct / Math.max(stopDistancePct, 0.0001);
  let adjusted = Math.min(llmRisk.adjusted_position_size_pct, maxSizeByRisk);
  const reasons = [...llmRisk.reasons];

  if (portfolio.currentExposurePct + adjusted > rules.maxExposurePct) {
    adjusted = Math.max(0, rules.maxExposurePct - portfolio.currentExposurePct);
    reasons.push("Hard guard: max exposure exceeded.");
  }

  if (portfolio.currentDrawdownPct >= rules.drawdownCutoffPct) {
    adjusted = 0;
    reasons.push("Hard guard: drawdown cutoff reached.");
  }

  if (atrPct > rules.maxAtrPct) {
    adjusted *= 0.5;
    reasons.push("Hard guard: ATR volatility threshold breached.");
  }

  if (portfolio.liquidityUsd < rules.minLiquidityUsd) {
    adjusted = 0;
    reasons.push("Hard guard: liquidity below minimum.");
  }

  const approved = llmRisk.approved && adjusted >= 0.25;
  return {
    approved,
    adjusted_position_size_pct: round(clamp(adjusted, 0, rules.maxExposurePct), 3),
    risk_score: round(clamp(Math.max(llmRisk.risk_score, stopDistancePct * 8 + atrPct * 2), 0, 100), 3),
    reasons
  };
};

export const enforceExecutionHardGuards = (
  llmDecision: ExecutionDecision,
  proposal: TradeProposal,
  risk: RiskDecision,
  portfolio: PortfolioState
): ExecutionDecision => {
  if (!risk.approved) {
    return {
      approve: false,
      capital_allocated: 0,
      execution_instructions: null,
      reasons: [...llmDecision.reasons, "Hard guard: risk gate rejected proposal."]
    };
  }

  const maxCapital = portfolio.equityUsd * (risk.adjusted_position_size_pct / 100);
  const approved = llmDecision.approve && llmDecision.capital_allocated > 0;
  if (!approved) {
    return {
      approve: false,
      capital_allocated: 0,
      execution_instructions: null,
      reasons: [...llmDecision.reasons, "Hard guard: invalid or zero capital allocation."]
    };
  }

  const capitalAllocated = Math.min(llmDecision.capital_allocated, maxCapital);
  return {
    approve: true,
    capital_allocated: round(capitalAllocated, 2),
    execution_instructions: llmDecision.execution_instructions
      ? {
          ...llmDecision.execution_instructions,
          side: proposal.side === "long" ? "buy" : "sell",
          quantity_notional_usd: round(capitalAllocated, 2)
        }
      : {
          type: "market",
          tif: "IOC",
          side: proposal.side === "long" ? "buy" : "sell",
          quantity_notional_usd: round(capitalAllocated, 2)
        },
    reasons: llmDecision.reasons
  };
};
