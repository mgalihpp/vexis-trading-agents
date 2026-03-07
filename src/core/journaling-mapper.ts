import type {
  ExecutionDecision,
  ExecutionReport,
  PipelineMode,
  PortfolioDecision,
  PostTradeEvaluation,
  ProposalDecision,
  RiskDecision,
} from "../types";

const safeNum = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export const mapProposalCreated = (input: {
  nowIso: string;
  mode: PipelineMode;
  asset: string;
  timeframe: string;
  proposal: ProposalDecision;
  accountBalanceUsd: number;
}): Record<string, unknown> => ({
  stage: "proposal_created",
  timestamp: input.nowIso,
  mode: input.mode,
  asset: input.asset,
  timeframe: input.timeframe,
  proposal: input.proposal,
  account_balance_usd: input.accountBalanceUsd,
});

export const mapRiskEvaluated = (input: {
  proposal: ProposalDecision;
  risk: RiskDecision;
}): Record<string, unknown> => ({
  stage: "risk_evaluated",
  proposal_ref: input.proposal,
  risk: input.risk,
});

export const mapPortfolioDecided = (input: {
  proposal: ProposalDecision;
  portfolio: PortfolioDecision;
}): Record<string, unknown> => ({
  stage: "portfolio_decided",
  proposal_ref: input.proposal,
  portfolio: input.portfolio,
});

export const mapExecutionDecided = (input: {
  decision: ExecutionDecision;
  report?: ExecutionReport;
  proposal: ProposalDecision;
}): Record<string, unknown> => ({
  stage: "execution_decided",
  execution_decision: input.decision,
  execution_report: input.report
    ? {
        filled: input.report.filled,
        fillPrice: safeNum(input.report.fillPrice),
        pnl_total_usd: safeNum(input.report.pnl.totalUsd),
        slippage_bps: safeNum(input.report.execution_details?.slippage_bps),
      }
    : null,
  proposal_ref: input.proposal,
});

export const mapPostTradeEvaluated = (input: {
  evaluation: PostTradeEvaluation;
}): Record<string, unknown> => ({
  stage: "post_trade_evaluated",
  evaluation: input.evaluation,
});

export const mapRunSummary = (input: {
  approved: boolean;
  reasons: string[];
  traceId: string;
  runId: string;
  mode: PipelineMode;
  asset: string;
}): Record<string, unknown> => ({
  stage: "run_summarized",
  run_id: input.runId,
  trace_id: input.traceId,
  mode: input.mode,
  asset: input.asset,
  approved: input.approved,
  reasons: input.reasons,
});
