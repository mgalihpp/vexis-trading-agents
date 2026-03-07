import type {
  AgentContext,
  EventStore,
  ExecutionDecision,
  ExecutionInstruction,
  PortfolioDecision,
  ProposalDecision,
} from "../types";
import { round } from "../utils/common";
import { BaseAgent } from "./base";

export interface ExecutionControllerInput {
  proposal: ProposalDecision;
  portfolioDecision: PortfolioDecision;
  minOrderNotionalUsd?: number;
  precisionStep?: number;
  metadataSource?: "exchange" | "fallback_env";
}

export class ExecutionController extends BaseAgent<ExecutionControllerInput, ExecutionDecision> {
  public readonly name = "ExecutionController";

  public constructor(eventStore: EventStore) {
    super(eventStore);
  }

  public async run(input: ExecutionControllerInput, ctx: AgentContext): Promise<ExecutionDecision> {
    const reasons: string[] = [...input.portfolioDecision.reasons];

    if (!input.portfolioDecision.approved) {
      const rejected: ExecutionDecision = {
        portfolio_approved: false,
        executable: false,
        approved_notional_usd: 0,
        execution_blocker: "portfolio_rejected",
        execution_instructions: null,
        reasons,
      };
      await this.logDecision(ctx, input, rejected, "Execution denied because portfolio allocator did not approve.");
      return rejected;
    }

    const minNotional = input.minOrderNotionalUsd;
    const notional = round(input.portfolioDecision.approved_notional_usd, 2);
    const hasMinNotional = typeof minNotional === "number" && Number.isFinite(minNotional) && minNotional > 0;
    const executable = hasMinNotional ? notional >= minNotional : false;
    const instructions: ExecutionInstruction | null = executable && input.proposal.proposal_type === "trade"
      ? {
          type: "market",
          tif: "IOC",
          side: input.proposal.side === "long" ? "buy" : "sell",
          quantity_notional_usd: notional,
          min_notional_usd: minNotional,
          precision_step: input.precisionStep,
          metadata_source: input.metadataSource ?? "fallback_env",
        }
      : null;

    if (!hasMinNotional) {
      reasons.push("exchange min notional metadata unavailable");
    } else if (!executable) {
      reasons.push("approved_notional_usd below exchange minimum order size");
    }

    const output: ExecutionDecision = {
      portfolio_approved: true,
      executable,
      approved_notional_usd: notional,
      execution_blocker: executable ? null : hasMinNotional ? "min_notional_not_met" : "min_notional_unavailable",
      execution_instructions: instructions,
      reasons,
    };

    await this.logDecision(ctx, input, output, "Validated exchange realism and produced executable/non-executable order decision.");
    return output;
  }
}
