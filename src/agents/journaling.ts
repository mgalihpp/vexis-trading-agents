import {
  mapExecutionDecided,
  mapPortfolioDecided,
  mapPostTradeEvaluated,
  mapProposalCreated,
  mapRiskEvaluated,
  mapRunSummary,
} from "../core/journaling-mapper";
import type { DecisionRunner } from "../core/llm-runner";
import type {
  AdvisorySnapshot,
  AgentContext,
  ExecutionDecision,
  ExecutionReport,
  FinalDecisionByLLM,
  JournalingClient,
  JournalingEventType,
  LLMDecisionAbort,
  PipelineMode,
  PortfolioDecision,
  PostTradeEvaluation,
  ProposalDecision,
  RiskDecision,
} from "../types";

interface ProposalInput {
  asset: string;
  timeframe: string;
  proposal: ProposalDecision;
  accountBalanceUsd: number;
}

interface RiskInput {
  proposal: ProposalDecision;
  risk: RiskDecision;
}

interface PortfolioInput {
  proposal: ProposalDecision;
  portfolio: PortfolioDecision;
}

interface ExecutionInput {
  decision: ExecutionDecision;
  report?: ExecutionReport;
  proposal: ProposalDecision;
  advisorySnapshot?: AdvisorySnapshot | null;
  finalDecisionByLLM?: FinalDecisionByLLM | null;
  llmDecisionAbort?: LLMDecisionAbort | null;
}

interface PostTradeInput {
  evaluation: PostTradeEvaluation;
}

interface SummaryInput {
  approved: boolean;
  reasons: string[];
}

export class JournalingAgent {
  private readonly tradeIdByRunId = new Map<string, string>();

  public constructor(
    private readonly client: JournalingClient,
    _decisionRunner?: DecisionRunner,
    _llmMaxRetries = 2,
  ) {}

  public getTradeId(runId: string): string | undefined {
    return this.tradeIdByRunId.get(runId);
  }

  public async onProposalCreated(ctx: AgentContext, input: ProposalInput): Promise<string> {
    const payload = mapProposalCreated({
      nowIso: ctx.nowIso(),
      mode: ctx.mode,
      asset: input.asset,
      timeframe: input.timeframe,
      proposal: input.proposal,
      accountBalanceUsd: input.accountBalanceUsd,
    });
    const created = await this.client.postTrade(payload, this.meta(ctx, "proposal_created"));
    this.tradeIdByRunId.set(ctx.runId, created.id);
    return created.id;
  }

  public async onRiskEvaluated(ctx: AgentContext, input: RiskInput): Promise<void> {
    const tradeId = this.tradeIdByRunId.get(ctx.runId);
    if (!tradeId) return;
    await this.client.patchTrade(tradeId, mapRiskEvaluated(input), this.meta(ctx, "risk_evaluated"));
  }

  public async onPortfolioDecided(ctx: AgentContext, input: PortfolioInput): Promise<void> {
    const tradeId = this.tradeIdByRunId.get(ctx.runId);
    if (!tradeId) return;
    await this.client.patchTrade(tradeId, mapPortfolioDecided(input), this.meta(ctx, "portfolio_decided"));
  }

  public async onExecutionDecided(ctx: AgentContext, input: ExecutionInput): Promise<void> {
    const tradeId = this.tradeIdByRunId.get(ctx.runId);
    if (!tradeId) return;
    await this.client.patchTrade(tradeId, mapExecutionDecided(input), this.meta(ctx, "execution_decided"));
  }

  public async onPostTradeEvaluated(ctx: AgentContext, input: PostTradeInput): Promise<void> {
    const tradeId = this.tradeIdByRunId.get(ctx.runId);
    if (!tradeId) return;
    await this.client.patchTrade(tradeId, mapPostTradeEvaluated(input), this.meta(ctx, "post_trade_evaluated"));
  }

  public async onRunSummarized(ctx: AgentContext, input: SummaryInput): Promise<void> {
    const tradeId = this.tradeIdByRunId.get(ctx.runId);
    if (!tradeId) return;
    await this.client.patchTrade(
      tradeId,
      mapRunSummary({
        approved: input.approved,
        reasons: input.reasons,
        traceId: ctx.traceId,
        runId: ctx.runId,
        mode: ctx.mode,
        asset: ctx.asset,
      }),
      this.meta(ctx, "run_summarized"),
    );
  }

  public clear(runId: string): void {
    this.tradeIdByRunId.delete(runId);
  }

  private meta(ctx: AgentContext, eventType: JournalingEventType): {
    idempotencyKey: string;
    traceId: string;
    runId: string;
    mode: PipelineMode;
    asset: string;
    eventType: JournalingEventType;
  } {
    const eventTs = ctx.nowIso();
    return {
      idempotencyKey: `${ctx.traceId}:${eventType}:${eventTs}`,
      traceId: ctx.traceId,
      runId: ctx.runId,
      mode: ctx.mode,
      asset: ctx.asset,
      eventType,
    };
  }
}
