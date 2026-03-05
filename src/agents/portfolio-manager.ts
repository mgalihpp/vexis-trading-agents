import type {
  AgentContext,
  ExecutionDecision,
  EventStore,
  PortfolioState,
  RiskDecision,
  TradeProposal
} from "../types";
import { round } from "../utils/common";
import { BaseAgent } from "./base";

export interface PortfolioInput {
  proposal: TradeProposal;
  risk: RiskDecision;
  portfolio: PortfolioState;
}

export class PortfolioManager extends BaseAgent<PortfolioInput, ExecutionDecision> {
  public readonly name = "PortfolioManager";

  public constructor(eventStore: EventStore) {
    super(eventStore);
  }

  public async run(input: PortfolioInput, ctx: AgentContext): Promise<ExecutionDecision> {
    const reasons: string[] = [...input.risk.reasons];

    if (!input.risk.approved) {
      const rejected: ExecutionDecision = {
        approve: false,
        capital_allocated: 0,
        execution_instructions: null,
        reasons: reasons.length ? reasons : ["Risk manager rejected trade proposal."]
      };
      await this.logDecision(ctx, input, rejected, "Rejected allocation because risk gate did not approve the proposal.");
      return rejected;
    }

    const capital_allocated = round(input.portfolio.equityUsd * (input.risk.adjusted_position_size_pct / 100), 2);
    const execution: ExecutionDecision = {
      approve: true,
      capital_allocated,
      execution_instructions: {
        type: "market",
        tif: "IOC",
        side: input.proposal.side === "long" ? "buy" : "sell",
        quantity_notional_usd: capital_allocated
      },
      reasons: reasons.length ? reasons : ["Approved within risk and exposure budget."]
    };

    await this.logDecision(ctx, input, execution, "Allocated capital according to adjusted risk-approved sizing.");
    return execution;
  }
}
