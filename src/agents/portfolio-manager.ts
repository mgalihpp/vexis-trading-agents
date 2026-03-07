import type {
  AgentContext,
  EventStore,
  PortfolioDecision,
  PortfolioState,
  ProposalDecision,
  RiskDecision,
} from "../types";
import { round } from "../utils/common";
import { BaseAgent } from "./base";

export interface PortfolioInput {
  proposal: ProposalDecision;
  risk: RiskDecision;
  portfolio: PortfolioState;
}

export class PortfolioManager extends BaseAgent<PortfolioInput, PortfolioDecision> {
  public readonly name = "PortfolioManager";

  public constructor(eventStore: EventStore) {
    super(eventStore);
  }

  public async run(input: PortfolioInput, ctx: AgentContext): Promise<PortfolioDecision> {
    const reasons: string[] = [...input.risk.reasons];

    if (!input.risk.approved) {
      const rejected: PortfolioDecision = {
        approved: false,
        approved_position_size_pct_equity: 0,
        approved_notional_usd: 0,
        concentration_check: input.risk.evaluation_state === "not_applicable" ? "not_applicable" : "fail",
        correlation_check: input.risk.evaluation_state === "not_applicable" ? "not_applicable" : "fail",
        reserve_cash_check: "not_applicable",
        reasons: reasons.length ? reasons : ["Risk manager rejected trade proposal."],
      };
      await this.logDecision(ctx, input, rejected, "Rejected allocation because risk gate did not approve the proposal.");
      return rejected;
    }

    const remainingBudget = Math.max(0, input.portfolio.max_additional_allocation_pct ?? (100 - input.portfolio.currentExposurePct));
    const concentrationCap = Math.max(0, 100 - (input.portfolio.cluster_exposure_pct ?? 0));
    const pct = Math.min(input.risk.approved_position_size_pct_equity, remainingBudget, concentrationCap);
    const approvedNotional = round(input.portfolio.equityUsd * (pct / 100), 2);
    const reserveCashOk = input.portfolio.liquidityUsd - approvedNotional >= 0;

    const output: PortfolioDecision = {
      approved: approvedNotional > 0,
      approved_position_size_pct_equity: round(pct, 3),
      approved_notional_usd: approvedNotional,
      concentration_check: pct <= concentrationCap ? "pass" : "fail",
      correlation_check: "pass",
      reserve_cash_check: reserveCashOk ? "pass" : "fail",
      reasons: reasons.length ? reasons : ["Approved capital allocation under portfolio budget constraints."],
    };

    await this.logDecision(ctx, input, output, "Capital allocator only: budget/concentration-aware final notional assignment.");
    return output;
  }
}
