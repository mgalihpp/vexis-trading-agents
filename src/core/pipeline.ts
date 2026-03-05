import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type {
  Agent,
  AgentContext,
  AnalystBundle,
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
  PortfolioState,
  RiskDecision,
  RiskRules,
  TelemetrySink,
  TradeProposal
} from "../types";
import type { DecisionRunner } from "./llm-runner";
import {
  bearishResearchSchema,
  bullishResearchSchema,
  debateOutputSchema,
  decisionEnvelopeSchema,
  executionDecisionSchema,
  fundamentalsAnalysisSchema,
  newsAnalysisSchema,
  riskDecisionSchema,
  sentimentAnalysisSchema,
  technicalAnalysisSchema,
  tradeProposalSchema
} from "./schemas";
import { enforceExecutionHardGuards, enforceRiskHardGuards } from "./safety";
import { BacktestDataProvider, RealCryptoDataProvider } from "./market-data";
import { TimeoutBudget, withTimeout } from "./ops";
import type { HealthMonitor } from "./health";

const noopTelemetrySink: TelemetrySink = {
  emitLog: async () => undefined,
  emitMetric: async () => undefined,
  emitAlert: async () => undefined
};

export interface PipelineAgents {
  fundamentalsAnalyst: Agent<import("../types").FundamentalsData, import("../types").FundamentalsAnalysis>;
  sentimentAnalyst: Agent<import("../types").SentimentSignal[], import("../types").SentimentAnalysis>;
  newsAnalyst: Agent<import("../types").NewsEvent[], import("../types").NewsAnalysis>;
  technicalAnalyst: Agent<import("../types").OHLCVCandle[], import("../types").TechnicalAnalysis>;
  bullishResearcher: Agent<AnalystBundle, import("../types").BullishResearch>;
  bearishResearcher: Agent<AnalystBundle, import("../types").BearishResearch>;
  debateSynthesizer: Agent<{ bullish: import("../types").BullishResearch; bearish: import("../types").BearishResearch }, import("../types").DebateOutput>;
  traderAgent: Agent<{ asset: string; lastPrice: number; analysts: AnalystBundle; debate: import("../types").DebateOutput }, TradeProposal>;
  riskManager: Agent<{ proposal: TradeProposal; portfolio: PortfolioState; rules: RiskRules; atrPct: number }, RiskDecision>;
  portfolioManager: Agent<{ proposal: TradeProposal; risk: RiskDecision; portfolio: PortfolioState }, ExecutionDecision>;
  simulatedExchange: Agent<{ decision: ExecutionDecision; proposal: TradeProposal; marketPrice: number }, ExecutionReport>;
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
  contextFactory?: (input: PipelineRunRequest, traceId: string) => AgentContext;
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
  proposal: Annotation<TradeProposal | null>,
  riskDecision: Annotation<RiskDecision | null>,
  executionDecision: Annotation<ExecutionDecision | null>,
  executionReport: Annotation<ExecutionReport | null>
});

type TradingStateType = typeof TradingState.State;

const llmPrompt = (role: string, extra: string): string =>
  [
    `You are ${role} in a hedge-fund style trading system.`,
    "Return strictly valid JSON matching the provided schema.",
    "Do not include markdown or prose outside JSON.",
    "Reasoning must be concise and practical.",
    extra
  ].join(" ");

const eventTags = (ctx: AgentContext, node: string, source?: string, provider?: string): MetricTags => ({
  trace_id: ctx.traceId,
  run_id: ctx.runId,
  asset: ctx.asset,
  mode: ctx.mode,
  node,
  source: source ?? "system",
  provider: provider ?? ""
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
  retries = 0
): Promise<void> => {
  await store.append({
    runId,
    traceId,
    agent,
    timestamp,
    inputPayload,
    outputPayload,
    decisionRationale,
    source,
    retries
  });
};

const logDecisionResult = async (
  deps: PipelineDeps,
  ctx: AgentContext,
  agentName: string,
  inputPayload: JSONValue,
  result: LLMRunnerResult<{ output: JSONValue; decision_rationale: string }>
): Promise<void> => {
  const sink = deps.telemetrySink ?? noopTelemetrySink;
  await appendLog(
    deps.eventStore,
    ctx.runId,
    ctx.traceId,
    agentName,
    ctx.nowIso(),
    inputPayload,
    result.output.output,
    result.output.decision_rationale,
    result.source,
    result.retries
  );

  await sink.emitMetric({
    name: "node_fallback_rate",
    value: result.source === "fallback" ? 1 : 0,
    timestamp: ctx.nowIso(),
    tags: eventTags(ctx, agentName, result.source)
  });
};

const buildGraph = (deps: PipelineDeps, ctx: AgentContext, budget: TimeoutBudget) => {
  const sink = deps.telemetrySink ?? noopTelemetrySink;
  const nodeMaxRetries = Math.max(0, deps.llmMaxRetries ?? 2);
  const nodeTimeoutMs = Math.max(0, deps.nodeTimeoutMs ?? 0);
  const runDecision = <T>(args: Parameters<DecisionRunner["runWithFallback"]>[0]): Promise<LLMRunnerResult<T>> =>
    deps.decisionRunner.runWithFallback({
      ...args,
      trace: { traceId: ctx.traceId, runId: ctx.runId, mode: ctx.mode, asset: ctx.asset }
    }) as Promise<LLMRunnerResult<T>>;

  const wrapNode = <T extends TradingStateType>(
    nodeName: string,
    fn: (state: T) => Promise<Partial<T>>
  ) => async (state: T): Promise<Partial<T>> => {
    const startedMs = Date.now();
    budget.assertRemaining(nodeName);

    try {
      const result = await withTimeout(fn(state), nodeTimeoutMs, `NODE_TIMEOUT:${nodeName}`);
      await sink.emitMetric({
        name: "node_latency_ms",
        value: Date.now() - startedMs,
        timestamp: ctx.nowIso(),
        tags: eventTags(ctx, nodeName)
      });
      return result;
    } catch (error) {
      await sink.emitMetric({
        name: "node_error_rate",
        value: 1,
        timestamp: ctx.nowIso(),
        tags: eventTags(ctx, nodeName)
      });
      await sink.emitAlert({
        timestamp: ctx.nowIso(),
        name: "node_failure",
        severity: "critical",
        trace_id: ctx.traceId,
        tags: eventTags(ctx, nodeName),
        node: nodeName,
        message: String(error),
        last_successful_run: undefined
      });
      throw error;
    }
  };

  const graph = new StateGraph(TradingState)
    .addNode(
      "market_data_node",
      wrapNode("MarketData", async (state: TradingStateType) => {
        deps.marketDataProvider.setRunContext?.({
          runId: ctx.runId,
          traceId: ctx.traceId,
          mode: ctx.mode,
          asset: state.query.asset
        });
        const snapshot = await deps.marketDataProvider.getSnapshot(state.query);
        await appendLog(
          deps.eventStore,
          ctx.runId,
          ctx.traceId,
          "MarketData",
          ctx.nowIso(),
          state.query,
          snapshot,
          "Fetched market snapshot from selected provider",
          "system",
          0
        );

        for (const providerStatus of snapshot.providerStatus) {
          await appendLog(
            deps.eventStore,
            ctx.runId,
            ctx.traceId,
            "DataProviderStatus",
            ctx.nowIso(),
            {
              provider: providerStatus.provider,
              statusCode: providerStatus.statusCode
            },
            providerStatus,
            `Provider ${providerStatus.provider} status=${providerStatus.statusCode} records=${providerStatus.recordCount}`,
            "system",
            0
          );

          await sink.emitMetric({
            name: "provider_latency_ms",
            value: providerStatus.latencyMs,
            timestamp: ctx.nowIso(),
            tags: eventTags(ctx, "MarketData", "system", providerStatus.provider)
          });
          await sink.emitMetric({
            name: "provider_status_code",
            value: providerStatus.statusCode,
            timestamp: ctx.nowIso(),
            tags: eventTags(ctx, "MarketData", "system", providerStatus.provider)
          });
          await sink.emitMetric({
            name: "provider_error_rate",
            value: providerStatus.ok ? 0 : 1,
            timestamp: ctx.nowIso(),
            tags: eventTags(ctx, "MarketData", "system", providerStatus.provider)
          });

          if (deps.healthMonitor) {
            deps.healthMonitor.recordProviderHealth({
              target: providerStatus.provider,
              kind: "provider",
              state: providerStatus.ok ? "healthy" : providerStatus.statusCode >= 500 ? "down" : "degraded",
              timestamp: ctx.nowIso(),
              message: providerStatus.message ?? "provider status update",
              tags: eventTags(ctx, "MarketData", "system", providerStatus.provider)
            });
          }
        }
        return { snapshot };
      })
    )
    .addNode(
      "analyst_team_node",
      wrapNode("AnalystTeam", async (state: TradingStateType) => {
        if (!state.snapshot) {
          throw new Error("snapshot is required for analyst_team");
        }

        const fundamentalsInput = state.snapshot.fundamentals;
        const fundamentalsResult = await runDecision({
          config: { nodeName: "FundamentalsAnalyst", maxRetries: nodeMaxRetries },
          schema: decisionEnvelopeSchema(fundamentalsAnalysisSchema),
          systemPrompt: llmPrompt("FundamentalsAnalyst", "Assess valuation bias, red flags, and confidence."),
          input: fundamentalsInput,
          fallback: async () => ({
            output: await deps.agents.fundamentalsAnalyst.run(fundamentalsInput, ctx),
            decision_rationale: "Fallback deterministic fundamentals scoring"
          })
        });
        await logDecisionResult(deps, ctx, "FundamentalsAnalyst", fundamentalsInput, fundamentalsResult as LLMRunnerResult<{ output: JSONValue; decision_rationale: string }>);

        const sentimentInput = state.snapshot.sentimentSignals;
        const sentimentResult = await runDecision({
          config: { nodeName: "SentimentAnalyst", maxRetries: nodeMaxRetries },
          schema: decisionEnvelopeSchema(sentimentAnalysisSchema),
          systemPrompt: llmPrompt("SentimentAnalyst", "Produce sentiment score -1..1, mood and confidence."),
          input: sentimentInput,
          fallback: async () => ({
            output: await deps.agents.sentimentAnalyst.run(sentimentInput, ctx),
            decision_rationale: "Fallback deterministic sentiment averaging"
          })
        });
        await logDecisionResult(deps, ctx, "SentimentAnalyst", sentimentInput, sentimentResult as LLMRunnerResult<{ output: JSONValue; decision_rationale: string }>);

        const newsInput = state.snapshot.newsEvents;
        const newsResult = await runDecision({
          config: { nodeName: "NewsAnalyst", maxRetries: nodeMaxRetries },
          schema: decisionEnvelopeSchema(newsAnalysisSchema),
          systemPrompt: llmPrompt("NewsAnalyst", "Evaluate macro/news directional impact, sectors, severity, confidence."),
          input: newsInput,
          fallback: async () => ({
            output: await deps.agents.newsAnalyst.run(newsInput, ctx),
            decision_rationale: "Fallback deterministic event aggregation"
          })
        });
        await logDecisionResult(deps, ctx, "NewsAnalyst", newsInput, newsResult as LLMRunnerResult<{ output: JSONValue; decision_rationale: string }>);

        const technicalInput = state.snapshot.candles;
        const technicalResult = await runDecision({
          config: { nodeName: "TechnicalAnalyst", maxRetries: nodeMaxRetries },
          schema: decisionEnvelopeSchema(technicalAnalysisSchema),
          systemPrompt: llmPrompt("TechnicalAnalyst", "Interpret indicators and return trend/signal with key levels."),
          input: technicalInput,
          fallback: async () => ({
            output: await deps.agents.technicalAnalyst.run(technicalInput, ctx),
            decision_rationale: "Fallback indicator engine output"
          })
        });
        await logDecisionResult(deps, ctx, "TechnicalAnalyst", technicalInput, technicalResult as LLMRunnerResult<{ output: JSONValue; decision_rationale: string }>);

        const analysts: AnalystBundle = {
          fundamentals: fundamentalsResult.output.output,
          sentiment: sentimentResult.output.output,
          news: newsResult.output.output,
          technical: technicalResult.output.output
        };

        return { analysts };
      })
    )
    .addNode(
      "bullish_research_node",
      wrapNode("BullishResearcher", async (state: TradingStateType) => {
        if (!state.analysts) {
          throw new Error("analysts output is required for bullish research");
        }

        const result = await runDecision({
          config: { nodeName: "BullishResearcher", maxRetries: nodeMaxRetries },
          schema: decisionEnvelopeSchema(bullishResearchSchema),
          systemPrompt: llmPrompt("BullishResearcher", "Argue upside thesis and expected reward from analyst packet."),
          input: state.analysts,
          fallback: async () => ({
            output: await deps.agents.bullishResearcher.run(state.analysts, ctx),
            decision_rationale: "Fallback deterministic bullish thesis"
          })
        });

        await logDecisionResult(deps, ctx, "BullishResearcher", state.analysts, result as LLMRunnerResult<{ output: JSONValue; decision_rationale: string }>);
        return { bullishResearch: result.output.output };
      })
    )
    .addNode(
      "bearish_research_node",
      wrapNode("BearishResearcher", async (state: TradingStateType) => {
        if (!state.analysts) {
          throw new Error("analysts output is required for bearish research");
        }

        const result = await runDecision({
          config: { nodeName: "BearishResearcher", maxRetries: nodeMaxRetries },
          schema: decisionEnvelopeSchema(bearishResearchSchema),
          systemPrompt: llmPrompt("BearishResearcher", "Argue downside thesis and key failure modes from analyst packet."),
          input: state.analysts,
          fallback: async () => ({
            output: await deps.agents.bearishResearcher.run(state.analysts, ctx),
            decision_rationale: "Fallback deterministic bearish thesis"
          })
        });

        await logDecisionResult(deps, ctx, "BearishResearcher", state.analysts, result as LLMRunnerResult<{ output: JSONValue; decision_rationale: string }>);
        return { bearishResearch: result.output.output };
      })
    )
    .addNode(
      "debate_node",
      wrapNode("DebateSynthesizer", async (state: TradingStateType) => {
        if (!state.bullishResearch || !state.bearishResearch) {
          throw new Error("both bullish and bearish research are required for debate");
        }

        const input = { bullish: state.bullishResearch, bearish: state.bearishResearch };
        const result = await runDecision({
          config: { nodeName: "DebateSynthesizer", maxRetries: nodeMaxRetries },
          schema: decisionEnvelopeSchema(debateOutputSchema),
          systemPrompt: llmPrompt("DebateSynthesizer", "Synthesize bullish and bearish arguments into final bias and confidence."),
          input,
          fallback: async () => ({
            output: await deps.agents.debateSynthesizer.run(input, ctx),
            decision_rationale: "Fallback deterministic debate synthesis"
          })
        });

        await logDecisionResult(deps, ctx, "DebateSynthesizer", input, result as LLMRunnerResult<{ output: JSONValue; decision_rationale: string }>);
        return { debate: result.output.output };
      })
    )
    .addNode(
      "trader_node",
      wrapNode("TraderAgent", async (state: TradingStateType) => {
        if (!state.analysts || !state.debate || !state.snapshot) {
          throw new Error("analysts, debate, and snapshot are required for trader");
        }

        const input = {
          asset: state.snapshot.asset,
          lastPrice: state.snapshot.lastPrice,
          analysts: state.analysts,
          debate: state.debate
        };

        const result = await runDecision({
          config: { nodeName: "TraderAgent", maxRetries: nodeMaxRetries },
          schema: decisionEnvelopeSchema(tradeProposalSchema),
          systemPrompt: llmPrompt("TraderAgent", "Create trade proposal with entry, stop, target, size, and reasoning."),
          input,
          fallback: async () => ({
            output: await deps.agents.traderAgent.run(input, ctx),
            decision_rationale: "Fallback deterministic trade proposal"
          })
        });

        await logDecisionResult(deps, ctx, "TraderAgent", input, result as LLMRunnerResult<{ output: JSONValue; decision_rationale: string }>);
        return { proposal: result.output.output };
      })
    )
    .addNode(
      "risk_node",
      wrapNode("RiskManager", async (state: TradingStateType) => {
        if (!state.proposal || !state.snapshot || !state.analysts) {
          throw new Error("proposal, snapshot, and analysts are required for risk");
        }

        const atrPct = state.snapshot.lastPrice === 0 ? 0 : (state.analysts.technical.indicators.atr / state.snapshot.lastPrice) * 100;
        const input = {
          proposal: state.proposal,
          portfolio: state.portfolio,
          rules: state.riskRules,
          atrPct
        };

        const result = await runDecision({
          config: { nodeName: "RiskManager", maxRetries: nodeMaxRetries },
          schema: decisionEnvelopeSchema(riskDecisionSchema),
          systemPrompt: llmPrompt("RiskManager", "Validate proposal against risk policy and produce approval with adjusted size."),
          input,
          fallback: async () => ({
            output: await deps.agents.riskManager.run(input, ctx),
            decision_rationale: "Fallback deterministic risk control"
          })
        });

        const guarded = enforceRiskHardGuards(result.output.output, state.proposal, state.portfolio, state.riskRules, atrPct);
        await appendLog(
          deps.eventStore,
          ctx.runId,
          ctx.traceId,
          "RiskManager",
          ctx.nowIso(),
          input,
          guarded,
          `${result.output.decision_rationale}; hard guards applied`,
          result.source,
          result.retries
        );

        return { riskDecision: guarded };
      })
    )
    .addNode(
      "portfolio_node",
      wrapNode("PortfolioManager", async (state: TradingStateType) => {
        if (!state.proposal || !state.riskDecision) {
          throw new Error("proposal and risk decision are required for portfolio");
        }

        const input = {
          proposal: state.proposal,
          risk: state.riskDecision,
          portfolio: state.portfolio
        };

        const result = await runDecision({
          config: { nodeName: "PortfolioManager", maxRetries: nodeMaxRetries },
          schema: decisionEnvelopeSchema(executionDecisionSchema),
          systemPrompt: llmPrompt("PortfolioManager", "Make final approve/reject decision and execution instructions."),
          input,
          fallback: async () => ({
            output: await deps.agents.portfolioManager.run(input, ctx),
            decision_rationale: "Fallback deterministic portfolio allocation"
          })
        });

        const guarded = enforceExecutionHardGuards(result.output.output, state.proposal, state.riskDecision, state.portfolio);
        await appendLog(
          deps.eventStore,
          ctx.runId,
          ctx.traceId,
          "PortfolioManager",
          ctx.nowIso(),
          input,
          guarded,
          `${result.output.decision_rationale}; hard guards applied`,
          result.source,
          result.retries
        );

        return { executionDecision: guarded };
      })
    )
    .addNode(
      "execution_approved",
      wrapNode("SimulatedExchange", async (state: TradingStateType) => {
        if (!state.executionDecision || !state.proposal || !state.snapshot) {
          throw new Error("execution decision, proposal, and snapshot are required for execution");
        }

        const executionReport = await deps.agents.simulatedExchange.run(
          {
            decision: state.executionDecision,
            proposal: state.proposal,
            marketPrice: state.snapshot.lastPrice
          },
          ctx
        );

        return { executionReport };
      })
    )
    .addNode(
      "execution_rejected",
      wrapNode("SimulatedExchange", async (state: TradingStateType) => {
        if (!state.executionDecision || !state.proposal || !state.snapshot) {
          throw new Error("execution decision, proposal, and snapshot are required for execution");
        }

        const noFillDecision: ExecutionDecision = {
          ...state.executionDecision,
          approve: false,
          capital_allocated: 0,
          execution_instructions: null,
          reasons: [...state.executionDecision.reasons, "Execution path: rejected by portfolio/risk controls."]
        };

        const executionReport = await deps.agents.simulatedExchange.run(
          {
            decision: noFillDecision,
            proposal: state.proposal,
            marketPrice: state.snapshot.lastPrice
          },
          ctx
        );

        return { executionDecision: noFillDecision, executionReport };
      })
    )
    .addEdge(START, "market_data_node")
    .addEdge("market_data_node", "analyst_team_node")
    .addEdge("analyst_team_node", "bullish_research_node")
    .addEdge("bullish_research_node", "bearish_research_node")
    .addEdge("bearish_research_node", "debate_node")
    .addEdge("debate_node", "trader_node")
    .addEdge("trader_node", "risk_node")
    .addEdge("risk_node", "portfolio_node")
    .addConditionalEdges("portfolio_node", (state: TradingStateType) => {
      if (state.executionDecision?.approve) {
        return "execution_approved";
      }
      return "execution_rejected";
    })
    .addEdge("execution_approved", END)
    .addEdge("execution_rejected", END);

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
      : {
          runId: input.runId,
          traceId,
          mode,
          asset: input.query.asset,
          nowIso: () => new Date().toISOString()
        };

    const sink = this.deps.telemetrySink ?? noopTelemetrySink;
    const startedMs = Date.now();

    try {
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
          proposal: null,
          riskDecision: null,
          executionDecision: null,
          executionReport: null
        }),
        runBudget.remainingMs(),
        "RUN_TIMEOUT"
      );

      if (!finalState.executionDecision || !finalState.executionReport) {
        throw new Error("Pipeline execution incomplete: missing final decision or execution report.");
      }

      const logs = this.deps.eventStore.getAll();
      const decisionLogs = logs.filter((l) => ["llm", "fallback"].includes(l.source));
      const fallbackCount = decisionLogs.filter((l) => l.source === "fallback").length;
      const fallbackRatio = decisionLogs.length === 0 ? 0 : fallbackCount / decisionLogs.length;
      const runLatencyMs = Date.now() - startedMs;

      await sink.emitMetric({
        name: "run_latency_ms",
        value: runLatencyMs,
        timestamp: ctx.nowIso(),
        tags: eventTags(ctx, "Pipeline")
      });
      await sink.emitMetric({
        name: "run_success",
        value: 1,
        timestamp: ctx.nowIso(),
        tags: eventTags(ctx, "Pipeline")
      });

      if (this.deps.healthMonitor) {
        await this.deps.healthMonitor.recordRun({
          runId: input.runId,
          traceId,
          latencyMs: runLatencyMs,
          fallbackRatio,
          success: true,
          mode,
          asset: input.query.asset,
          timestamp: ctx.nowIso()
        });
      }

      return {
        traceId,
        executionDecision: finalState.executionDecision,
        executionReport: finalState.executionReport,
        logs
      };
    } catch (error) {
      await sink.emitMetric({
        name: "run_success",
        value: 0,
        timestamp: ctx.nowIso(),
        tags: eventTags(ctx, "Pipeline")
      });

      await sink.emitAlert({
        timestamp: ctx.nowIso(),
        name: "run_failure",
        severity: "critical",
        trace_id: traceId,
        tags: eventTags(ctx, "Pipeline"),
        message: String(error),
        last_successful_run: undefined
      });

      if (this.deps.healthMonitor) {
        await this.deps.healthMonitor.recordRun({
          runId: input.runId,
          traceId,
          latencyMs: Date.now() - startedMs,
          fallbackRatio: 1,
          success: false,
          mode,
          asset: input.query.asset,
          timestamp: ctx.nowIso()
        });
      }

      throw error;
    }
  }
}

export interface CreateDataProviderOptions {
  strictRealMode: boolean;
  theNewsApiKey: string;
  coinGeckoApiKey: string;
  theNewsApiBaseUrl: string;
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
  if (mode === "backtest") {
    return new BacktestDataProvider();
  }
  return new RealCryptoDataProvider({
    strictRealMode: options.strictRealMode,
    theNewsApiKey: options.theNewsApiKey,
    coinGeckoApiKey: options.coinGeckoApiKey,
    theNewsApiBaseUrl: options.theNewsApiBaseUrl,
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
    retryPolicy: options.retryPolicy
  });
};

export const runBacktestCycle = async (
  deps: Omit<PipelineDeps, "marketDataProvider">,
  input: PipelineRunRequest
): Promise<PipelineRunResult> => {
  const pipeline = new TradingPipeline({ ...deps, marketDataProvider: new BacktestDataProvider() });
  return pipeline.runCycle(input);
};

export const runPaperOrLiveSimCycle = async (
  deps: Omit<PipelineDeps, "marketDataProvider">,
  input: PipelineRunRequest,
  options: CreateDataProviderOptions
): Promise<PipelineRunResult> => {
  const pipeline = new TradingPipeline({ ...deps, marketDataProvider: createModeDataProvider("paper", options) });
  return pipeline.runCycle(input);
};











