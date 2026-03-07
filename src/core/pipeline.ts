import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type {
  Agent,
  AgentContext,
  AnalystBundle,
  DataQualityContext,
  DecisionLogEntry,
  EventStore,
  ExecutionDecision,
  ExecutionReport,
  JSONValue,
  LLMRunnerResult,
  MarketDataProvider,
  MarketDataQuery,
  MarketSnapshot,
  MetricTags,
  PipelineMode,
  PortfolioDecision,
  PortfolioState,
  PostTradeEvaluation,
  ProposalDecision,
  RiskDecision,
  RiskRules,
  TelemetrySink,
  TradeProposal,
} from "../types";
import type { DecisionRunner } from "./llm-runner";
import {
  bearishResearchSchema,
  bullishResearchSchema,
  decisionEnvelopeSchema,
  debateOutputSchema,
  executionDecisionSchema,
  fundamentalsAnalysisSchema,
  newsAnalysisSchema,
  portfolioDecisionSchema,
  postTradeEvaluationSchema,
  proposalDecisionSchema,
  riskDecisionSchema,
  sentimentAnalysisSchema,
  technicalAnalysisSchema,
  tradeProposalSchema,
} from "./schemas";
import { enforceExecutionHardGuards, enforcePortfolioHardGuards, enforceRiskHardGuards } from "./safety";
import { BacktestDataProvider, RealCryptoDataProvider } from "./market-data";
import { TimeoutBudget, withTimeout } from "./ops";
import type { HealthMonitor } from "./health";
import type { JournalingAgent } from "../agents/journaling";
import type { SqliteCalibrationStore } from "./calibration-store";
import { DecisionController } from "./decision-controller";

const noopTelemetrySink: TelemetrySink = {
  emitLog: async () => undefined,
  emitMetric: async () => undefined,
  emitAlert: async () => undefined,
};

export interface PipelineAgents {
  fundamentalsAnalyst: Agent<import("../types").FundamentalsData, import("../types").FundamentalsAnalysis>;
  sentimentAnalyst: Agent<import("../types").SentimentSignal[], import("../types").SentimentAnalysis>;
  newsAnalyst: Agent<import("../types").NewsEvent[], import("../types").NewsAnalysis>;
  technicalAnalyst: Agent<import("../types").OHLCVCandle[], import("../types").TechnicalAnalysis>;
  evidenceNormalizer: Agent<
    {
      analysts: Omit<AnalystBundle, "normalized_evidence" | "dependency_overlap_score" | "data_quality">;
      providerStatus: Array<{ ok: boolean; latencyMs: number; provider: string; statusCode: number }>;
    },
    AnalystBundle
  >;
  bullishResearcher: Agent<AnalystBundle, import("../types").BullishResearch>;
  bearishResearcher: Agent<AnalystBundle, import("../types").BearishResearch>;
  debateSynthesizer: Agent<{ bullish: import("../types").BullishResearch; bearish: import("../types").BearishResearch }, import("../types").DebateOutput>;
  traderAgent: Agent<{ asset: string; lastPrice: number; inputTimeframe: string; analysts: AnalystBundle; debate: import("../types").DebateOutput }, TradeProposal>;
  riskManager: Agent<
    {
      proposal: ProposalDecision;
      portfolio: PortfolioState;
      rules: RiskRules;
      atrPct: number;
      regimeState?: import("../types").RegimeState;
      calibratedProbability?: number;
    },
    RiskDecision
  >;
  portfolioManager: Agent<{ proposal: ProposalDecision; risk: RiskDecision; portfolio: PortfolioState }, PortfolioDecision>;
  executionController: Agent<
    { proposal: ProposalDecision; portfolioDecision: PortfolioDecision; minOrderNotionalUsd?: number; precisionStep?: number; metadataSource?: "exchange" | "fallback_env" },
    ExecutionDecision
  >;
  simulatedExchange: Agent<{ decision: ExecutionDecision; proposal: ProposalDecision; marketPrice: number }, ExecutionReport>;
  postTradeEvaluator: Agent<
    {
      proposal: ProposalDecision;
      report: ExecutionReport;
      expectedSlippageBps?: number;
      proposalCreatedAtIso: string;
      executionFinishedAtIso: string;
      regime: "low_vol" | "trend" | "high_vol_news";
    },
    PostTradeEvaluation
  >;
}

export interface PipelineDeps {
  eventStore: EventStore;
  marketDataProvider: MarketDataProvider;
  decisionRunner: DecisionRunner;
  agents: PipelineAgents;
  riskRules: RiskRules;
  telemetrySink?: TelemetrySink;
  healthMonitor?: HealthMonitor;
  llmMaxRetries?: number;
  runTimeoutMs?: number;
  nodeTimeoutMs?: number;
  mode?: PipelineMode;
  minOrderNotionalUsd?: number;
  minOrderPrecisionStep?: number;
  calibrationStore?: SqliteCalibrationStore;
  contextFactory?: (input: PipelineRunRequest, traceId: string) => AgentContext;
  onLogEvent?: (event: DecisionLogEntry) => Promise<void> | void;
  journalingAgent?: JournalingAgent;
}

export interface PipelineRunRequest {
  runId: string;
  traceId?: string;
  mode?: PipelineMode;
  query: MarketDataQuery;
  portfolio: PortfolioState;
}

export interface PipelineRunResult {
  traceId: string;
  executionDecision: ExecutionDecision;
  executionReport: ExecutionReport;
  postTradeEvaluation: PostTradeEvaluation | null;
  logs: DecisionLogEntry[];
}

const TradingState = Annotation.Root({
  runId: Annotation<string>,
  query: Annotation<MarketDataQuery>,
  portfolio: Annotation<PortfolioState>,
  riskRules: Annotation<RiskRules>,
  snapshot: Annotation<MarketSnapshot | null>,
  analysts: Annotation<AnalystBundle | null>,
  bullishResearch: Annotation<import("../types").BullishResearch | null>,
  bearishResearch: Annotation<import("../types").BearishResearch | null>,
  debate: Annotation<import("../types").DebateOutput | null>,
  noTradeDecision: Annotation<import("../types").NoTradeDecision | null>,
  proposal: Annotation<ProposalDecision | null>,
  riskDecision: Annotation<RiskDecision | null>,
  portfolioDecision: Annotation<PortfolioDecision | null>,
  executionDecision: Annotation<ExecutionDecision | null>,
  executionReport: Annotation<ExecutionReport | null>,
  postTradeEvaluation: Annotation<PostTradeEvaluation | null>,
  proposalCreatedAtIso: Annotation<string | null>,
});

type TradingStateType = typeof TradingState.State;

const llmPrompt = (role: string, extra: string): string =>
  [
    `You are ${role} in a hedge-fund style trading system.`,
    "Return strictly valid JSON matching the provided schema.",
    "Do not include markdown or prose outside JSON.",
    "Reasoning must be concise and practical.",
    extra,
  ].join(" ");

const eventTags = (ctx: AgentContext, node: string, source?: string, provider?: string): MetricTags => ({
  trace_id: ctx.traceId,
  run_id: ctx.runId,
  asset: ctx.asset,
  mode: ctx.mode,
  node,
  source: source ?? "system",
  provider: provider ?? "",
});

export const appendLog = async (
  store: EventStore,
  runId: string,
  traceId: string,
  agent: string,
  timestamp: string,
  inputPayload: JSONValue,
  outputPayload: JSONValue,
  decisionRationale: string,
  source: "llm" | "fallback" | "system" = "system",
  retries = 0,
): Promise<DecisionLogEntry> => {
  const event: DecisionLogEntry = {
    runId,
    traceId,
    agent,
    timestamp,
    inputPayload,
    outputPayload,
    decisionRationale,
    source,
    retries,
  };
  await store.append(event);
  return event;
};

const appendAndNotify = async (
  deps: PipelineDeps,
  runId: string,
  traceId: string,
  agent: string,
  timestamp: string,
  inputPayload: JSONValue,
  outputPayload: JSONValue,
  decisionRationale: string,
  source: "llm" | "fallback" | "system" = "system",
  retries = 0,
): Promise<void> => {
  const event = await appendLog(
    deps.eventStore,
    runId,
    traceId,
    agent,
    timestamp,
    inputPayload,
    outputPayload,
    decisionRationale,
    source,
    retries,
  );
  await deps.onLogEvent?.(event);
};

const logDecisionResult = async (
  deps: PipelineDeps,
  ctx: AgentContext,
  agentName: string,
  inputPayload: JSONValue,
  result: LLMRunnerResult<{ output: JSONValue; decision_rationale: string }>,
): Promise<void> => {
  const sink = deps.telemetrySink ?? noopTelemetrySink;
  await appendAndNotify(
    deps,
    ctx.runId,
    ctx.traceId,
    agentName,
    ctx.nowIso(),
    inputPayload,
    result.output.output,
    result.output.decision_rationale,
    result.source,
    result.retries,
  );
  await sink.emitMetric({
    name: "node_fallback_rate",
    value: result.source === "fallback" ? 1 : 0,
    timestamp: ctx.nowIso(),
    tags: eventTags(ctx, agentName, result.source),
  });
};

const deriveDataQuality = (snapshot: MarketSnapshot): DataQualityContext => {
  const providerCount = Math.max(snapshot.providerStatus.length, 1);
  const healthy = snapshot.providerStatus.filter((p) => p.ok).length;
  const degraded = snapshot.providerStatus.filter((p) => !p.ok).map((p) => p.provider);
  const avgLatency = snapshot.providerStatus.reduce((sum, p) => sum + p.latencyMs, 0) / providerCount;
  const usableNews = snapshot.newsEvents.filter((n) => (n.relevance_score ?? 0) >= 0.35);
  return {
    market_data_freshness_sec: Math.max(1, avgLatency / 1000),
    news_data_quality: usableNews.length >= 2 ? "high" : usableNews.length === 1 ? "medium" : "low",
    sentiment_data_quality: snapshot.sentimentSignals.length > 0 ? "high" : "low",
    provider_health_score: healthy / providerCount,
    degraded_providers: degraded,
  };
};

const buildGraph = (deps: PipelineDeps, ctx: AgentContext, budget: TimeoutBudget) => {
  const sink = deps.telemetrySink ?? noopTelemetrySink;
  const decisionController = new DecisionController();
  const nodeMaxRetries = Math.max(0, deps.llmMaxRetries ?? 2);
  const nodeTimeoutMs = Math.max(0, deps.nodeTimeoutMs ?? 0);
  const runDecision = <T>(args: Parameters<DecisionRunner["runWithFallback"]>[0]): Promise<LLMRunnerResult<T>> =>
    deps.decisionRunner.runWithFallback({
      ...args,
      trace: { traceId: ctx.traceId, runId: ctx.runId, mode: ctx.mode, asset: ctx.asset },
    }) as Promise<LLMRunnerResult<T>>;
  const runJournalingHook = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (!deps.journalingAgent) return undefined;
    try {
      return await fn();
    } catch {
      return undefined;
    }
  };

  const wrapNode =
    <T extends TradingStateType>(nodeName: string, fn: (state: T) => Promise<Partial<T>>) =>
    async (state: T): Promise<Partial<T>> => {
      budget.assertRemaining(nodeName);
      const started = Date.now();
      const out = await withTimeout(fn(state), nodeTimeoutMs, `NODE_TIMEOUT:${nodeName}`);
      decisionController.record({
        stage: nodeName,
        startedAt: new Date(started).toISOString(),
        finishedAt: ctx.nowIso(),
        latencyMs: Date.now() - started,
        source: "system",
        retries: 0,
        validSchema: true,
      });
      await sink.emitMetric({
        name: "node_latency_ms",
        value: Date.now() - started,
        timestamp: ctx.nowIso(),
        tags: eventTags(ctx, nodeName),
      });
      return out;
    };

  const graph = new StateGraph(TradingState)
    .addNode("market_data_node", wrapNode("MarketData", async (state: TradingStateType) => {
      deps.marketDataProvider.setRunContext?.({
        runId: ctx.runId,
        traceId: ctx.traceId,
        mode: ctx.mode,
        asset: state.query.asset,
      });
      const snapshot = await deps.marketDataProvider.getSnapshot(state.query);
      await appendAndNotify(deps, ctx.runId, ctx.traceId, "MarketData", ctx.nowIso(), state.query, snapshot, "Fetched market snapshot from selected provider", "system", 0);
      return { snapshot };
    }))
    .addNode("analyst_team_node", wrapNode("AnalystTeam", async (state: TradingStateType) => {
      if (!state.snapshot) throw new Error("snapshot is required for analyst_team");

      const fundamentalsResult = await runDecision({
        config: { nodeName: "FundamentalsAnalyst", maxRetries: nodeMaxRetries },
        schema: decisionEnvelopeSchema(fundamentalsAnalysisSchema),
        systemPrompt: llmPrompt("FundamentalsAnalyst", "Assess valuation bias, red flags, confidence vector and evidence."),
        input: state.snapshot.fundamentals,
        fallback: async () => ({
          output: await deps.agents.fundamentalsAnalyst.run(state.snapshot!.fundamentals, ctx),
          decision_rationale: "Fallback deterministic fundamentals scoring",
        }),
      });
      await logDecisionResult(deps, ctx, "FundamentalsAnalyst", state.snapshot.fundamentals, fundamentalsResult as LLMRunnerResult<{ output: JSONValue; decision_rationale: string }>);

      const sentimentResult = await runDecision({
        config: { nodeName: "SentimentAnalyst", maxRetries: nodeMaxRetries },
        schema: decisionEnvelopeSchema(sentimentAnalysisSchema),
        systemPrompt: llmPrompt("SentimentAnalyst", "Produce sentiment score, confidence vector and evidence."),
        input: state.snapshot.sentimentSignals,
        fallback: async () => ({
          output: await deps.agents.sentimentAnalyst.run(state.snapshot!.sentimentSignals, ctx),
          decision_rationale: "Fallback deterministic sentiment averaging",
        }),
      });
      await logDecisionResult(deps, ctx, "SentimentAnalyst", state.snapshot.sentimentSignals, sentimentResult as LLMRunnerResult<{ output: JSONValue; decision_rationale: string }>);

      const newsResult = await runDecision({
        config: { nodeName: "NewsAnalyst", maxRetries: nodeMaxRetries },
        schema: decisionEnvelopeSchema(newsAnalysisSchema),
        systemPrompt: llmPrompt("NewsAnalyst", "Evaluate directional impact with confidence vector and evidence."),
        input: state.snapshot.newsEvents,
        fallback: async () => ({
          output: await deps.agents.newsAnalyst.run(state.snapshot!.newsEvents, ctx),
          decision_rationale: "Fallback deterministic event aggregation",
        }),
      });
      await logDecisionResult(deps, ctx, "NewsAnalyst", state.snapshot.newsEvents, newsResult as LLMRunnerResult<{ output: JSONValue; decision_rationale: string }>);

      const technicalResult = await runDecision({
        config: { nodeName: "TechnicalAnalyst", maxRetries: nodeMaxRetries },
        schema: decisionEnvelopeSchema(technicalAnalysisSchema),
        systemPrompt: llmPrompt("TechnicalAnalyst", "Generate TA v2 output with confidence vector and evidence."),
        input: state.snapshot.candles,
        fallback: async () => ({
          output: await deps.agents.technicalAnalyst.run(state.snapshot!.candles, ctx),
          decision_rationale: "Fallback indicator engine output",
        }),
      });
      await logDecisionResult(deps, ctx, "TechnicalAnalyst", state.snapshot.candles, technicalResult as LLMRunnerResult<{ output: JSONValue; decision_rationale: string }>);

      const analystsRaw = {
        fundamentals: fundamentalsResult.output.output as import("../types").FundamentalsAnalysis,
        sentiment: sentimentResult.output.output as import("../types").SentimentAnalysis,
        news: newsResult.output.output as import("../types").NewsAnalysis,
        technical: technicalResult.output.output as import("../types").TechnicalAnalysis,
      };

      const normalized = await deps.agents.evidenceNormalizer.run({
        analysts: analystsRaw,
        providerStatus: state.snapshot.providerStatus.map((p) => ({
          ok: p.ok,
          latencyMs: p.latencyMs,
          provider: p.provider,
          statusCode: p.statusCode,
        })),
      }, ctx);
      normalized.data_quality = normalized.data_quality ?? deriveDataQuality(state.snapshot);

      return { analysts: normalized };
    }))
    .addNode("bullish_research_node", wrapNode("BullishResearcher", async (state: TradingStateType) => {
      if (!state.analysts) throw new Error("analysts output is required for bullish research");
      const result = await runDecision({
        config: { nodeName: "BullishResearcher", maxRetries: nodeMaxRetries },
        schema: decisionEnvelopeSchema(bullishResearchSchema),
        systemPrompt: llmPrompt("BullishResearcher", "Output structured bullish thesis, invalidation triggers and confidence vector."),
        input: state.analysts,
        fallback: async () => ({
          output: await deps.agents.bullishResearcher.run(state.analysts!, ctx),
          decision_rationale: "Fallback deterministic bullish thesis",
        }),
      });
      await logDecisionResult(deps, ctx, "BullishResearcher", state.analysts as unknown as JSONValue, result as LLMRunnerResult<{ output: JSONValue; decision_rationale: string }>);
      return { bullishResearch: result.output.output as import("../types").BullishResearch };
    }))
    .addNode("bearish_research_node", wrapNode("BearishResearcher", async (state: TradingStateType) => {
      if (!state.analysts) throw new Error("analysts output is required for bearish research");
      const result = await runDecision({
        config: { nodeName: "BearishResearcher", maxRetries: nodeMaxRetries },
        schema: decisionEnvelopeSchema(bearishResearchSchema),
        systemPrompt: llmPrompt("BearishResearcher", "Output structured bearish thesis, invalidation triggers and confidence vector."),
        input: state.analysts,
        fallback: async () => ({
          output: await deps.agents.bearishResearcher.run(state.analysts!, ctx),
          decision_rationale: "Fallback deterministic bearish thesis",
        }),
      });
      await logDecisionResult(deps, ctx, "BearishResearcher", state.analysts as unknown as JSONValue, result as LLMRunnerResult<{ output: JSONValue; decision_rationale: string }>);
      return { bearishResearch: result.output.output as import("../types").BearishResearch };
    }))
    .addNode("debate_node", wrapNode("DebateSynthesizer", async (state: TradingStateType) => {
      if (!state.bullishResearch || !state.bearishResearch) throw new Error("both bullish and bearish research are required for debate");
      const input = { bullish: state.bullishResearch, bearish: state.bearishResearch };
      const result = await runDecision({
        config: { nodeName: "DebateSynthesizer", maxRetries: nodeMaxRetries },
        schema: decisionEnvelopeSchema(debateOutputSchema),
        systemPrompt: llmPrompt("DebateSynthesizer", "Synthesize structured final bias/horizon/stability/monitor conditions."),
        input,
        fallback: async () => ({
          output: await deps.agents.debateSynthesizer.run(input, ctx),
          decision_rationale: "Fallback deterministic debate synthesis",
        }),
      });
      await logDecisionResult(deps, ctx, "DebateSynthesizer", input as unknown as JSONValue, result as LLMRunnerResult<{ output: JSONValue; decision_rationale: string }>);
      return { debate: result.output.output as import("../types").DebateOutput };
    }))
    .addNode("trader_node", wrapNode("TraderAgent", async (state: TradingStateType) => {
      if (!state.analysts || !state.debate || !state.snapshot) throw new Error("analysts, debate, and snapshot are required for trader");
      if (
        state.debate.final_bias === "neutral" ||
        state.debate.confidence.effective_confidence < 0.45 ||
        state.debate.decision_stability === "low"
      ) {
        const noTrade: import("../types").NoTradeDecision = {
          no_trade: true,
          reasons: [
            "No edge from debate synthesis.",
            state.debate.key_disagreement,
            state.debate.decision_stability === "low" ? "Decision stability is low." : "Directional conviction below threshold.",
          ],
          dominant_horizon: state.debate.dominant_horizon,
          confidence: state.debate.confidence,
          must_monitor_conditions: state.debate.must_monitor_conditions,
        };
        const proposal: ProposalDecision = {
          proposal_type: "no_trade",
          asset: state.snapshot.asset,
          input_timeframe: state.query.timeframe,
          decision_horizon: state.debate.dominant_horizon,
          reasons: noTrade.reasons,
          must_monitor_conditions: noTrade.must_monitor_conditions,
          confidence: state.debate.confidence,
        };
        proposalDecisionSchema.parse(proposal);
        await appendAndNotify(
          deps,
          ctx.runId,
          ctx.traceId,
          "NoTradeDecision",
          ctx.nowIso(),
          state.debate as unknown as JSONValue,
          noTrade as unknown as JSONValue,
          "No-trade selected as first-class decision.",
          "system",
          0,
        );
        await runJournalingHook(() =>
          deps.journalingAgent!.onProposalCreated(ctx, {
            asset: state.query.asset,
            timeframe: state.query.timeframe,
            proposal,
            accountBalanceUsd: state.portfolio.equityUsd,
          }),
        );
        return { noTradeDecision: noTrade, proposal, proposalCreatedAtIso: ctx.nowIso() };
      }
      const input = {
        asset: state.snapshot.asset,
        lastPrice: state.snapshot.lastPrice,
        inputTimeframe: state.query.timeframe,
        analysts: state.analysts,
        debate: state.debate,
      };
      const result = await runDecision({
        config: { nodeName: "TraderAgent", maxRetries: nodeMaxRetries },
        schema: decisionEnvelopeSchema(tradeProposalSchema),
        systemPrompt: llmPrompt("TraderAgent", "Create proposal only (no final sizing authority)."),
        input,
        fallback: async () => ({
          output: await deps.agents.traderAgent.run(input, ctx),
          decision_rationale: "Fallback deterministic trade proposal",
        }),
      });
      await logDecisionResult(deps, ctx, "TraderAgent", input as unknown as JSONValue, result as LLMRunnerResult<{ output: JSONValue; decision_rationale: string }>);
      const proposal = result.output.output as ProposalDecision;
      await runJournalingHook(() =>
        deps.journalingAgent!.onProposalCreated(ctx, {
          asset: state.query.asset,
          timeframe: state.query.timeframe,
          proposal,
          accountBalanceUsd: state.portfolio.equityUsd,
        }),
      );
      return { proposal, proposalCreatedAtIso: ctx.nowIso() };
    }))
    .addNode("no_trade_direct_node", wrapNode("NoTradeDecision", async (state: TradingStateType) => {
      if (!state.proposal || state.proposal.proposal_type !== "no_trade") {
        throw new Error("no-trade proposal required for no_trade_direct_node");
      }
      const riskDecision: RiskDecision = {
        action: "reject",
        approved: false,
        approved_position_size_pct_equity: 0,
        risk_score_raw: 0,
        risk_score_normalized: 0,
        risk_band: "low",
        evaluation_state: "not_applicable",
        binding_constraints: ["no_trade_abstain"],
        reasons: state.proposal.reasons,
      };
      const portfolioDecision: PortfolioDecision = {
        approved: false,
        approved_position_size_pct_equity: 0,
        approved_notional_usd: 0,
        concentration_check: "not_applicable",
        correlation_check: "not_applicable",
        reserve_cash_check: "not_applicable",
        reasons: state.proposal.reasons,
      };
      const executionDecision: ExecutionDecision = {
        portfolio_approved: false,
        executable: false,
        approved_notional_usd: 0,
        execution_blocker: "no_trade",
        execution_instructions: null,
        reasons: state.proposal.reasons,
      };
      return { riskDecision, portfolioDecision, executionDecision };
    }))
    .addNode("risk_node", wrapNode("RiskManager", async (state: TradingStateType) => {
      if (!state.proposal || !state.snapshot || !state.analysts) throw new Error("proposal, snapshot, and analysts are required for risk");
      if (state.proposal.proposal_type !== "trade") {
        throw new Error("risk_node requires trade proposal");
      }
      const atrPct = state.snapshot.lastPrice === 0 ? 0 : (state.analysts.technical.features.atr14 / state.snapshot.lastPrice) * 100;
      const input = {
        proposal: state.proposal,
        portfolio: state.portfolio,
        rules: state.riskRules,
        atrPct,
        regimeState: state.analysts.technical.regime.state,
        calibratedProbability: state.analysts.technical.signals.calibrated_probability,
      };
      const result = await runDecision({
        config: { nodeName: "RiskManager", maxRetries: nodeMaxRetries },
        schema: decisionEnvelopeSchema(riskDecisionSchema),
        systemPrompt: llmPrompt("RiskManager", "Return admissibility-only decision with normalized risk score and constraints."),
        input,
        fallback: async () => ({
          output: await deps.agents.riskManager.run(input, ctx),
          decision_rationale: "Fallback deterministic risk control",
        }),
      });
      const guarded = enforceRiskHardGuards(result.output.output as RiskDecision, state.proposal, state.portfolio, state.riskRules, atrPct);
      await appendAndNotify(deps, ctx.runId, ctx.traceId, "RiskManager", ctx.nowIso(), input as unknown as JSONValue, guarded as unknown as JSONValue, `${result.output.decision_rationale}; hard guards applied`, result.source, result.retries);
      await runJournalingHook(() =>
        deps.journalingAgent!.onRiskEvaluated(ctx, {
          proposal: state.proposal!,
          risk: guarded,
        }),
      );
      return { riskDecision: guarded };
    }))
    .addNode("portfolio_node", wrapNode("PortfolioManager", async (state: TradingStateType) => {
      if (!state.proposal || !state.riskDecision) throw new Error("proposal and risk decision are required for portfolio");
      const input = { proposal: state.proposal, risk: state.riskDecision, portfolio: state.portfolio };
      const result = await runDecision({
        config: { nodeName: "PortfolioManager", maxRetries: nodeMaxRetries },
        schema: decisionEnvelopeSchema(portfolioDecisionSchema),
        systemPrompt: llmPrompt("PortfolioManager", "Allocate capital only; do not override risk admissibility."),
        input,
        fallback: async () => ({
          output: await deps.agents.portfolioManager.run(input, ctx),
          decision_rationale: "Fallback deterministic portfolio allocation",
        }),
      });
      const guarded = enforcePortfolioHardGuards(result.output.output as PortfolioDecision, state.riskDecision, state.portfolio);
      await appendAndNotify(deps, ctx.runId, ctx.traceId, "PortfolioManager", ctx.nowIso(), input as unknown as JSONValue, guarded as unknown as JSONValue, `${result.output.decision_rationale}; hard guards applied`, result.source, result.retries);
      await runJournalingHook(() =>
        deps.journalingAgent!.onPortfolioDecided(ctx, {
          proposal: state.proposal!,
          portfolio: guarded,
        }),
      );
      return { portfolioDecision: guarded };
    }))
    .addNode("execution_controller_node", wrapNode("ExecutionController", async (state: TradingStateType) => {
      if (!state.proposal || !state.portfolioDecision) throw new Error("proposal and portfolio decision are required for execution controller");
      const input = {
        proposal: state.proposal,
        portfolioDecision: state.portfolioDecision,
        minOrderNotionalUsd: state.snapshot?.market_constraints?.min_notional_usd ?? deps.minOrderNotionalUsd ?? 0,
        precisionStep: state.snapshot?.market_constraints?.precision_step ?? deps.minOrderPrecisionStep ?? 0,
        metadataSource: state.snapshot?.market_constraints?.source ??
          (state.snapshot?.providerStatus.some((p) => p.provider === "ccxt" && p.ok)
          ? "exchange" as const
          : "fallback_env" as const),
      };
      const raw = await deps.agents.executionController.run(input, ctx);
      const guarded = enforceExecutionHardGuards(raw, state.portfolioDecision);
      return { executionDecision: guarded };
    }))
    .addNode("execution_terminal", wrapNode("SimulatedExchange", async (state: TradingStateType) => {
      if (!state.executionDecision || !state.proposal || !state.snapshot) throw new Error("execution decision, proposal, and snapshot are required for execution");
      const executionReport = await deps.agents.simulatedExchange.run(
        { decision: state.executionDecision, proposal: state.proposal, marketPrice: state.snapshot.lastPrice },
        ctx,
      );
      await runJournalingHook(() =>
        deps.journalingAgent!.onExecutionDecided(ctx, {
          decision: state.executionDecision!,
          report: executionReport,
          proposal: state.proposal!,
        }),
      );
      return { executionReport };
    }))
    .addNode("post_trade_evaluator_node", wrapNode("PostTradeEvaluator", async (state: TradingStateType) => {
      if (!state.proposal || !state.executionReport || !state.analysts) throw new Error("proposal, execution report and analysts are required for post trade evaluator");
      const createdAt = state.proposalCreatedAtIso ?? ctx.nowIso();
      const input = {
        proposal: state.proposal,
        report: state.executionReport,
        expectedSlippageBps: state.snapshot?.lastPrice
          ? Math.max(1, Math.round((state.analysts.technical.features.atr14 / state.snapshot.lastPrice) * 10000 * 0.05))
          : 1,
        proposalCreatedAtIso: createdAt,
        executionFinishedAtIso: ctx.nowIso(),
        regime: state.analysts.technical.regime.state,
      };
      const evaluation = await deps.agents.postTradeEvaluator.run(input, ctx);
      postTradeEvaluationSchema.parse(evaluation);
      if (deps.calibrationStore) {
        for (const signal of evaluation.calibration_signals) {
          deps.calibrationStore.saveSignal({
            runId: ctx.runId,
            traceId: ctx.traceId,
            timestamp: ctx.nowIso(),
            agent: signal.agent,
            regime: signal.regime,
            expectedConfidence: signal.expected_confidence,
            outcomeScore: signal.outcome_score,
          });
        }
      }
      await runJournalingHook(() =>
        deps.journalingAgent!.onPostTradeEvaluated(ctx, {
          evaluation,
        }),
      );
      return { postTradeEvaluation: evaluation };
    }))
    .addEdge(START, "market_data_node")
    .addEdge("market_data_node", "analyst_team_node")
    .addEdge("analyst_team_node", "bullish_research_node")
    .addEdge("bullish_research_node", "bearish_research_node")
    .addEdge("bearish_research_node", "debate_node")
    .addEdge("debate_node", "trader_node")
    .addConditionalEdges("trader_node", (state: TradingStateType) => {
      if (state.proposal?.proposal_type === "no_trade") {
        return "no_trade_direct_node";
      }
      return "risk_node";
    })
    .addEdge("no_trade_direct_node", "execution_terminal")
    .addEdge("risk_node", "portfolio_node")
    .addEdge("portfolio_node", "execution_controller_node")
    .addEdge("execution_controller_node", "execution_terminal")
    .addEdge("execution_terminal", "post_trade_evaluator_node")
    .addEdge("post_trade_evaluator_node", END);

  return graph.compile();
};

export class TradingPipeline {
  public constructor(private readonly deps: PipelineDeps) {}

  public async runCycle(input: PipelineRunRequest): Promise<PipelineRunResult> {
    this.deps.eventStore.clear();
    const traceId = input.traceId ?? `trace-${input.runId}`;
    const mode = input.mode ?? this.deps.mode ?? "backtest";
    const runBudget = new TimeoutBudget(this.deps.runTimeoutMs ?? 0);
    const ctx = this.deps.contextFactory
      ? this.deps.contextFactory({ ...input, mode, traceId }, traceId)
      : { runId: input.runId, traceId, mode, asset: input.query.asset, nowIso: () => new Date().toISOString() };

    const app = buildGraph(this.deps, ctx, runBudget);
    const finalState = await withTimeout(
      app.invoke({
        runId: input.runId,
        query: input.query,
        portfolio: input.portfolio,
        riskRules: this.deps.riskRules,
        snapshot: null,
        analysts: null,
        bullishResearch: null,
        bearishResearch: null,
        debate: null,
        noTradeDecision: null,
        proposal: null,
        riskDecision: null,
        portfolioDecision: null,
        executionDecision: null,
        executionReport: null,
        postTradeEvaluation: null,
        proposalCreatedAtIso: null,
      }),
      runBudget.remainingMs(),
      "RUN_TIMEOUT",
    );

    if (!finalState.executionDecision || !finalState.executionReport) {
      throw new Error("Pipeline execution incomplete: missing final decision or execution report.");
    }
    if (this.deps.journalingAgent) {
      try {
        await this.deps.journalingAgent.onRunSummarized(ctx, {
          approved: finalState.executionDecision.portfolio_approved && finalState.executionDecision.executable,
          reasons: finalState.executionDecision.reasons,
        });
      } finally {
        this.deps.journalingAgent.clear(input.runId);
      }
    }
    return {
      traceId,
      executionDecision: finalState.executionDecision,
      executionReport: finalState.executionReport,
      postTradeEvaluation: finalState.postTradeEvaluation,
      logs: this.deps.eventStore.getAll(),
    };
  }
}

export interface CreateDataProviderOptions {
  strictRealMode: boolean;
  newsApiKey: string;
  coinGeckoApiKey: string;
  cryptocurrencyCvBaseUrl: string;
  newsApiBaseUrl: string;
  alternativeMeBaseUrl: string;
  coinGeckoBaseUrl: string;
  providerCacheTtlSeconds?: number;
  exchangeId?: string;
  telemetrySink?: TelemetrySink;
  healthMonitor?: HealthMonitor;
  traceId?: string;
  runId?: string;
  mode?: PipelineMode;
  requestsPerSecond?: number;
  timeoutMs?: number;
  retryPolicy?: {
    maxAttempts: number;
    initialDelayMs: number;
    backoffFactor: number;
    maxDelayMs: number;
    jitterMs: number;
  };
}

export const createModeDataProvider = (mode: PipelineMode, options: CreateDataProviderOptions): MarketDataProvider => {
  if (mode === "backtest") return new BacktestDataProvider();
  return new RealCryptoDataProvider({
    strictRealMode: options.strictRealMode,
    newsApiKey: options.newsApiKey,
    coinGeckoApiKey: options.coinGeckoApiKey,
    cryptocurrencyCvBaseUrl: options.cryptocurrencyCvBaseUrl,
    newsApiBaseUrl: options.newsApiBaseUrl,
    alternativeMeBaseUrl: options.alternativeMeBaseUrl,
    coinGeckoBaseUrl: options.coinGeckoBaseUrl,
    providerCacheTtlSeconds: options.providerCacheTtlSeconds,
    exchangeId: options.exchangeId,
    telemetrySink: options.telemetrySink,
    healthMonitor: options.healthMonitor,
    traceId: options.traceId,
    runId: options.runId,
    mode,
    requestsPerSecond: options.requestsPerSecond,
    timeoutMs: options.timeoutMs,
    retryPolicy: options.retryPolicy,
  });
};

export const runBacktestCycle = async (
  deps: Omit<PipelineDeps, "marketDataProvider">,
  input: PipelineRunRequest,
): Promise<PipelineRunResult> => {
  const pipeline = new TradingPipeline({ ...deps, marketDataProvider: new BacktestDataProvider() });
  return pipeline.runCycle(input);
};

export const runPaperOrLiveSimCycle = async (
  deps: Omit<PipelineDeps, "marketDataProvider">,
  input: PipelineRunRequest,
  options: CreateDataProviderOptions,
): Promise<PipelineRunResult> => {
  const pipeline = new TradingPipeline({
    ...deps,
    marketDataProvider: createModeDataProvider("paper", options),
  });
  return pipeline.runCycle(input);
};
