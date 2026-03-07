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
  portfolio: { equityUsd: number; liquidityUsd: number };
  riskRules: { maxRiskPerTradeUsd?: number; riskUsdTolerance?: number };
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
        execution_venue: "futures",
        portfolio_approved: false,
        executable: false,
        approved_notional_usd: 0,
        risk_budget_usd: input.riskRules.maxRiskPerTradeUsd ?? null,
        effective_risk_usd: null,
        required_margin_usd: null,
        leverage_used: null,
        execution_blocker: "portfolio_rejected",
        execution_instructions: null,
        reasons,
      };
      await this.logDecision(ctx, input, rejected, "Execution denied because portfolio allocator did not approve.");
      return rejected;
    }

    const minNotional = input.minOrderNotionalUsd;
    const riskBudgetUsd = Math.max(0, input.riskRules.maxRiskPerTradeUsd ?? 0);
    const riskTolerance = Math.max(1, input.riskRules.riskUsdTolerance ?? 1.1);
    const notionalByPortfolio = round(input.portfolioDecision.approved_notional_usd, 2);
    const hasMinNotional = typeof minNotional === "number" && Number.isFinite(minNotional) && minNotional > 0;
    const stopDistanceFraction = input.proposal.proposal_type === "trade"
      ? Math.max(input.proposal.stop_distance_fraction, 1e-9)
      : 0;
    const notionalByRisk = input.proposal.proposal_type === "trade" && riskBudgetUsd > 0
      ? round(riskBudgetUsd / stopDistanceFraction, 2)
      : notionalByPortfolio;
    const baseNotional = Math.max(notionalByPortfolio, notionalByRisk);
    const targetNotional = hasMinNotional ? Math.max(baseNotional, minNotional) : baseNotional;
    const effectiveRiskUsd = input.proposal.proposal_type === "trade"
      ? round(targetNotional * stopDistanceFraction, 6)
      : 0;
    const leverage = input.proposal.proposal_type === "trade" ? Math.max(1, input.proposal.leverage) : 1;
    const requiredMarginUsd = round(targetNotional / leverage, 6);
    const withinRiskTolerance = riskBudgetUsd <= 0 || effectiveRiskUsd <= riskBudgetUsd * riskTolerance;
    const hasMargin = input.portfolio.liquidityUsd >= requiredMarginUsd;
    const executable = hasMinNotional && withinRiskTolerance && hasMargin && input.proposal.proposal_type === "trade";
    const instructions: ExecutionInstruction | null = executable && input.proposal.proposal_type === "trade"
      ? {
          venue: "futures",
          type: "market",
          tif: "IOC",
          side: input.proposal.side === "long" ? "buy" : "sell",
          leverage,
          quantity_notional_usd: round(targetNotional, 2),
          required_margin_usd: requiredMarginUsd,
          min_notional_usd: minNotional,
          precision_step: input.precisionStep,
          metadata_source: input.metadataSource ?? "fallback_env",
        }
      : null;

    if (!hasMinNotional) {
      reasons.push("exchange min notional metadata unavailable");
    }
    if (hasMinNotional && targetNotional < minNotional!) {
      reasons.push("approved_notional_usd below exchange minimum order size");
    }
    if (!withinRiskTolerance) {
      reasons.push(
        `implied risk exceeds tolerance: implied=${round(effectiveRiskUsd, 4)} budget=${round(riskBudgetUsd * riskTolerance, 4)}`,
      );
    }
    if (!hasMargin) {
      reasons.push(
        `required margin exceeds available liquidity: required=${round(requiredMarginUsd, 4)} available=${round(input.portfolio.liquidityUsd, 4)}`,
      );
    }

    const output: ExecutionDecision = {
      execution_venue: "futures",
      portfolio_approved: true,
      executable,
      approved_notional_usd: round(targetNotional, 2),
      risk_budget_usd: riskBudgetUsd,
      effective_risk_usd: effectiveRiskUsd,
      required_margin_usd: requiredMarginUsd,
      leverage_used: leverage,
      execution_blocker: executable
        ? null
        : !hasMinNotional
          ? "min_notional_unavailable"
          : !withinRiskTolerance
            ? "risk_tolerance_exceeded"
            : !hasMargin
              ? "margin_insufficient"
              : "min_notional_not_met",
      execution_instructions: instructions,
      reasons,
    };

    await this.logDecision(ctx, input, output, "Validated exchange realism and produced executable/non-executable order decision.");
    return output;
  }
}
