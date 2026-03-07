import {
  mapExecutionDecided,
  mapProposalCreated,
  mapRiskEvaluated,
  mapRunSummary,
} from "../core/journaling-mapper";
import type { DecisionRunner } from "../core/llm-runner";
import { tradeSchema } from "../utils/schema/trade";
import type {
  AgentContext,
  ExecutionDecision,
  ExecutionReport,
  JournalingClient,
  JournalingEventType,
  JournalingRule,
  PipelineMode,
  RiskDecision,
  TradeProposal,
} from "../types";

interface ProposalInput {
  asset: string;
  timeframe: string;
  proposal: TradeProposal;
  accountBalanceUsd: number;
}

interface RiskInput {
  proposal: TradeProposal;
  risk: RiskDecision;
}

interface ExecutionInput {
  decision: ExecutionDecision;
  report?: ExecutionReport;
  proposal: TradeProposal;
}

interface SummaryInput {
  approved: boolean;
  reasons: string[];
}

const tradePatchSchema = tradeSchema.partial();

export class JournalingAgent {
  private readonly tradeIdByRunId = new Map<string, string>();
  private readonly rulesByRunId = new Map<string, JournalingRule[]>();

  public constructor(
    private readonly client: JournalingClient,
    private readonly decisionRunner?: DecisionRunner,
    private readonly llmMaxRetries = 2,
  ) {}

  public getTradeId(runId: string): string | undefined {
    return this.tradeIdByRunId.get(runId);
  }

  public async onProposalCreated(ctx: AgentContext, input: ProposalInput): Promise<string> {
    const meta = this.meta(ctx, "proposal_created");
    const rules = await this.client.listTradeRules(meta);
    this.rulesByRunId.set(ctx.runId, rules);
    const payload = await this.generateProposalPayload(ctx, input, rules);
    const created = await this.client.postTrade(payload, meta);
    this.tradeIdByRunId.set(ctx.runId, created.id);
    return created.id;
  }

  public async onRiskEvaluated(ctx: AgentContext, input: RiskInput): Promise<void> {
    const tradeId = this.tradeIdByRunId.get(ctx.runId);
    if (!tradeId) return;
    const payload = await this.generateRiskPayload(ctx, input);
    await this.client.patchTrade(tradeId, payload, this.meta(ctx, "risk_evaluated"));
  }

  public async onExecutionDecided(ctx: AgentContext, input: ExecutionInput): Promise<void> {
    const tradeId = this.tradeIdByRunId.get(ctx.runId);
    if (!tradeId) return;
    const payload = await this.generateExecutionPayload(ctx, input);
    await this.client.patchTrade(tradeId, payload, this.meta(ctx, "execution_decided"));
  }

  public async onRunSummarized(
    ctx: AgentContext,
    input: SummaryInput,
  ): Promise<void> {
    const tradeId = this.tradeIdByRunId.get(ctx.runId);
    if (!tradeId) return;
    const payload = await this.generateSummaryPayload(ctx, input);
    await this.client.patchTrade(tradeId, payload, this.meta(ctx, "run_summarized"));
  }

  public clear(runId: string): void {
    this.tradeIdByRunId.delete(runId);
    this.rulesByRunId.delete(runId);
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

  private async generateProposalPayload(
    ctx: AgentContext,
    input: ProposalInput,
    rules: JournalingRule[],
  ): Promise<Record<string, unknown>> {
    const fallback = async (): Promise<Record<string, unknown>> =>
      mapProposalCreated({
        nowIso: ctx.nowIso(),
        mode: ctx.mode,
        asset: input.asset,
        timeframe: input.timeframe,
        proposal: input.proposal,
        accountBalanceUsd: input.accountBalanceUsd,
        checklistRules: rules,
      });

    if (!this.decisionRunner) return fallback();

    const result = await this.decisionRunner.runWithFallback({
      config: { nodeName: "JournalingAgentProposal", maxRetries: this.llmMaxRetries },
      schema: tradeSchema,
      systemPrompt: [
        "You are JournalingAgent.",
        "Build JSON payload for POST /api/trades.",
        "Keep values natural from analysis context; UI options are guidance, not strict constraints.",
        "If rules exist, include checklist entries and mark mandatory items as checked.",
        "Return only fields that are useful for journaling quality.",
      ].join(" "),
      input: {
        event: "proposal_created",
        run: {
          mode: ctx.mode,
          asset: ctx.asset,
          timeframe: input.timeframe,
          now: ctx.nowIso(),
        },
        proposal: input.proposal,
        accountBalanceUsd: input.accountBalanceUsd,
        rules,
      },
      fallback,
      trace: {
        traceId: ctx.traceId,
        runId: ctx.runId,
        mode: ctx.mode,
        asset: ctx.asset,
      },
    });
    return result.output as Record<string, unknown>;
  }

  private async generateRiskPayload(
    ctx: AgentContext,
    input: RiskInput,
  ): Promise<Record<string, unknown>> {
    const fallback = async (): Promise<Record<string, unknown>> => mapRiskEvaluated(input);
    if (!this.decisionRunner) return fallback();

    const result = await this.decisionRunner.runWithFallback({
      config: { nodeName: "JournalingAgentRisk", maxRetries: this.llmMaxRetries },
      schema: tradePatchSchema,
      systemPrompt: [
        "You are JournalingAgent.",
        "Build JSON payload for PATCH /api/trades/:id after risk evaluation.",
        "Update risk-related fields and concise notes only.",
      ].join(" "),
      input: { event: "risk_evaluated", proposal: input.proposal, risk: input.risk },
      fallback,
      trace: {
        traceId: ctx.traceId,
        runId: ctx.runId,
        mode: ctx.mode,
        asset: ctx.asset,
      },
    });
    return result.output as Record<string, unknown>;
  }

  private async generateExecutionPayload(
    ctx: AgentContext,
    input: ExecutionInput,
  ): Promise<Record<string, unknown>> {
    const fallback = async (): Promise<Record<string, unknown>> => mapExecutionDecided(input);
    if (!this.decisionRunner) return fallback();

    const result = await this.decisionRunner.runWithFallback({
      config: { nodeName: "JournalingAgentExecution", maxRetries: this.llmMaxRetries },
      schema: tradePatchSchema,
      systemPrompt: [
        "You are JournalingAgent.",
        "Build JSON payload for PATCH /api/trades/:id after execution decision/report.",
        "Update outcome/result metrics and execution notes.",
      ].join(" "),
      input: {
        event: "execution_decided",
        decision: input.decision,
        report: input.report ?? null,
        proposal: input.proposal,
      },
      fallback,
      trace: {
        traceId: ctx.traceId,
        runId: ctx.runId,
        mode: ctx.mode,
        asset: ctx.asset,
      },
    });
    return result.output as Record<string, unknown>;
  }

  private async generateSummaryPayload(
    ctx: AgentContext,
    input: SummaryInput,
  ): Promise<Record<string, unknown>> {
    const fallback = async (): Promise<Record<string, unknown>> =>
      mapRunSummary({
        approved: input.approved,
        reasons: input.reasons,
        traceId: ctx.traceId,
        runId: ctx.runId,
        mode: ctx.mode,
        asset: ctx.asset,
      });
    if (!this.decisionRunner) return fallback();

    const result = await this.decisionRunner.runWithFallback({
      config: { nodeName: "JournalingAgentSummary", maxRetries: this.llmMaxRetries },
      schema: tradePatchSchema,
      systemPrompt: [
        "You are JournalingAgent.",
        "Build JSON payload for final PATCH /api/trades/:id run summary.",
        "Summarize key lesson, improvement, and action plan.",
      ].join(" "),
      input: {
        event: "run_summarized",
        approved: input.approved,
        reasons: input.reasons,
        traceId: ctx.traceId,
        runId: ctx.runId,
        mode: ctx.mode,
        asset: ctx.asset,
      },
      fallback,
      trace: {
        traceId: ctx.traceId,
        runId: ctx.runId,
        mode: ctx.mode,
        asset: ctx.asset,
      },
    });
    return result.output as Record<string, unknown>;
  }
}
