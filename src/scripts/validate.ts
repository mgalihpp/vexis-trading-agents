import assert from "node:assert/strict";
import {
  BearishResearcher,
  BullishResearcher,
  DebateSynthesizer,
  EvidenceNormalizer,
  ExecutionController,
  FundamentalsAnalyst,
  NewsAnalyst,
  PortfolioManager,
  PostTradeEvaluator,
  RiskManager,
  SentimentAnalyst,
  TechnicalAnalyst,
  TraderAgent,
} from "../agents";
import { InMemoryEventStore } from "../core/event-store";
import type { DecisionRunner } from "../core/llm-runner";
import { BacktestDataProvider } from "../core/market-data";
import { TradingPipeline } from "../core/pipeline";
import {
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
} from "../core/schemas";
import { SimulatedExchange } from "../sim/simulated-exchange";

class MockDecisionRunner implements DecisionRunner {
  public constructor(private readonly source: "llm" | "fallback") {}

  public async runWithFallback<T>(args: {
    config: { nodeName: string; maxRetries: number };
    schema: { parse: (input: unknown) => T };
    systemPrompt: string;
    input: unknown;
    fallback: () => Promise<T>;
    trace?: { traceId: string; runId: string; mode: string; asset: string };
  }): Promise<{ output: T; source: "llm" | "fallback"; retries: number; decisionRationale: string }> {
    const output = await args.fallback();
    return {
      output: args.schema.parse(output),
      source: this.source,
      retries: 0,
      decisionRationale: "mock",
    };
  }

  public async runWithMandatoryTool<T>(args: {
    config: { nodeName: string; maxRetries: number };
    schema: { parse: (input: unknown) => T };
    toolName: string;
    systemPrompt: string;
    input: unknown;
    trace?: { traceId: string; runId: string; mode: string; asset: string };
  }): Promise<
    | { output: T; source: "llm" | "fallback"; retries: number; decisionRationale: string }
    | { aborted: true; errorCode: "llm_tool_call_failed"; reason: string; retriesExhausted: number }
  > {
    const fallbackDecision = {
      decision_origin: "llm_tool_call",
      action: "execute_trade",
      reasons: ["Mock final decision approves advisory trade."],
      override_trace: [
        {
          advisory_source: "risk",
          advisory_signal: "reject",
          llm_signal: "execute_trade",
          reason: "Mock override for validation path.",
        },
      ],
      final_confidence: {
        signal_confidence: 0.8,
        data_quality_confidence: 0.8,
        model_reliability: 0.8,
        effective_confidence: 0.8,
      },
      must_monitor_conditions: ["Mock condition"],
    };
    return {
      output: args.schema.parse(fallbackDecision),
      source: this.source,
      retries: 0,
      decisionRationale: "mock-tool",
    };
  }
}

export const runDeterministicChecks = async (): Promise<void> => {
  const eventStore = new InMemoryEventStore();
  const riskRules = {
    maxRiskPerTradeUsd: 1,
    maxRiskPerTradePct: 1,
    riskUsdTolerance: 1.1,
    rrMinThreshold: 1.5,
    futuresMaxLeverage: 5,
    tpPartialSplit: [50, 30, 20],
    tpBreakevenAfterTp1: true,
    maxExposurePct: 35,
    drawdownCutoffPct: 12,
    maxAtrPct: 6,
    minLiquidityUsd: 20,
  };
  const pipeline = new TradingPipeline({
    eventStore,
    marketDataProvider: new BacktestDataProvider(),
    decisionRunner: new MockDecisionRunner("llm"),
    riskRules,
    agents: {
      fundamentalsAnalyst: new FundamentalsAnalyst(eventStore),
      sentimentAnalyst: new SentimentAnalyst(eventStore),
      newsAnalyst: new NewsAnalyst(eventStore),
      technicalAnalyst: new TechnicalAnalyst(eventStore),
      evidenceNormalizer: new EvidenceNormalizer(eventStore),
      bullishResearcher: new BullishResearcher(eventStore),
      bearishResearcher: new BearishResearcher(eventStore),
      debateSynthesizer: new DebateSynthesizer(eventStore),
      traderAgent: new TraderAgent(eventStore),
      riskManager: new RiskManager(eventStore),
      portfolioManager: new PortfolioManager(eventStore),
      executionController: new ExecutionController(eventStore),
      postTradeEvaluator: new PostTradeEvaluator(eventStore),
      simulatedExchange: new SimulatedExchange(eventStore),
    },
  });

  const run = await pipeline.runCycle({
    runId: "validate-v2",
    query: { asset: "BTC/USDT", timeframe: "1h", limit: 50 },
    portfolio: { equityUsd: 10000, currentExposurePct: 10, currentDrawdownPct: 2, liquidityUsd: 8000 },
  });

  assert.ok(run.executionDecision.portfolio_approved !== undefined, "Execution decision should include portfolio_approved");
  assert.ok(run.postTradeEvaluation !== null, "Post-trade evaluation should exist");

  const byAgent = new Map(run.logs.map((l) => [l.agent, l.outputPayload]));
  fundamentalsAnalysisSchema.parse(byAgent.get("FundamentalsAnalyst"));
  sentimentAnalysisSchema.parse(byAgent.get("SentimentAnalyst"));
  newsAnalysisSchema.parse(byAgent.get("NewsAnalyst"));
  technicalAnalysisSchema.parse(byAgent.get("TechnicalAnalyst"));
  debateOutputSchema.parse(byAgent.get("DebateSynthesizer"));
  const traderPayload = byAgent.get("TraderAgent") ?? byAgent.get("NoTradeDecision");
  if (traderPayload && typeof traderPayload === "object" && "proposal_type" in (traderPayload as Record<string, unknown>)) {
    proposalDecisionSchema.parse(traderPayload);
  } else if (byAgent.get("TraderAgent")) {
    tradeProposalSchema.parse(byAgent.get("TraderAgent"));
  }
  riskDecisionSchema.parse(byAgent.get("RiskManager"));
  portfolioDecisionSchema.parse(byAgent.get("PortfolioManager"));
  executionDecisionSchema.parse(byAgent.get("ExecutionController"));
  postTradeEvaluationSchema.parse(byAgent.get("PostTradeEvaluator"));

  console.log("Validation checks passed.");
};
