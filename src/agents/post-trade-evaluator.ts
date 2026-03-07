import type {
  AgentContext,
  EventStore,
  ExecutionReport,
  PostTradeEvaluation,
  ProposalDecision,
} from "../types";
import { clamp, round } from "../utils/common";
import { BaseAgent } from "./base";

export interface PostTradeEvaluatorInput {
  proposal: ProposalDecision;
  report: ExecutionReport;
  expectedSlippageBps?: number;
  proposalCreatedAtIso: string;
  executionFinishedAtIso: string;
  regime: "low_vol" | "trend" | "high_vol_news";
}

export class PostTradeEvaluator extends BaseAgent<PostTradeEvaluatorInput, PostTradeEvaluation> {
  public readonly name = "PostTradeEvaluator";

  public constructor(eventStore: EventStore) {
    super(eventStore);
  }

  public async run(input: PostTradeEvaluatorInput, ctx: AgentContext): Promise<PostTradeEvaluation> {
    const actualSlippage = input.report.execution_details?.slippage_bps ?? 0;
    const expectedSlippage = input.expectedSlippageBps ?? Math.max(1, actualSlippage);
    const slippageVsExpected = round(actualSlippage - expectedSlippage, 4);
    const delayMs = Math.max(0, new Date(input.executionFinishedAtIso).getTime() - new Date(input.proposalCreatedAtIso).getTime());
    const success = input.report.pnl.totalUsd > 0;

    if (input.proposal.proposal_type === "no_trade") {
      const abstentionQuality = clamp(
        (input.report.decision.execution_blocker === "no_trade" ? 0.9 : 0.5) *
          (input.proposal.confidence.effective_confidence > 0.5 ? 1 : 0.8),
        0,
        1,
      );
      const output: PostTradeEvaluation = {
        evaluation_type: "no_trade",
        slippage_vs_expected_bps: 0,
        entry_quality_score: null,
        stop_placement_quality_score: null,
        tp_realism_score: null,
        proposal_to_fill_delay_ms: delayMs,
        realized_risk_vs_predicted: 0,
        thesis_outcome: "inconclusive",
        abstention_quality_score: round(abstentionQuality, 4),
        missed_opportunity_score: null,
        calibration_signals: [
          {
            agent: "DebateSynthesizer",
            expected_confidence: input.proposal.confidence.effective_confidence,
            outcome_score: round(abstentionQuality, 4),
            regime: input.regime,
          },
        ],
      };
      await this.logDecision(ctx, input, output, "Evaluated abstention quality for explicit no-trade decision.");
      return output;
    }

    const rrPredicted = input.proposal.risk_reward_ratio;
    const rrRealized = input.report.pnl.totalUsd === 0 ? 0 : clamp(rrPredicted + input.report.pnl.totalUsd / Math.max(input.report.decision.approved_notional_usd, 1), -5, 5);

    const output: PostTradeEvaluation = {
      evaluation_type: "trade",
      slippage_vs_expected_bps: slippageVsExpected,
      entry_quality_score: round(clamp(1 - Math.abs(slippageVsExpected) / 30, 0, 1), 4),
      stop_placement_quality_score: round(clamp(input.proposal.stop_distance_pct >= 0.15 && input.proposal.stop_distance_pct <= 3 ? 0.8 : 0.45, 0, 1), 4),
      tp_realism_score: round(clamp(input.proposal.take_profit_distance_pct >= 0.2 ? 0.78 : 0.42, 0, 1), 4),
      proposal_to_fill_delay_ms: delayMs,
      realized_risk_vs_predicted: round(rrRealized - rrPredicted, 4),
      thesis_outcome: input.report.filled ? (success ? "success" : "failed") : "inconclusive",
      abstention_quality_score: null,
      missed_opportunity_score: null,
      calibration_signals: [
        {
          agent: "TechnicalAnalyst",
          expected_confidence: input.proposal.confidence.effective_confidence,
          outcome_score: success ? 1 : 0,
          regime: input.regime,
        },
        {
          agent: "DebateSynthesizer",
          expected_confidence: input.proposal.confidence.effective_confidence,
          outcome_score: success ? 1 : 0,
          regime: input.regime,
        },
        {
          agent: "TraderAgent",
          expected_confidence: input.proposal.confidence.effective_confidence,
          outcome_score: input.report.filled ? 1 : 0.25,
          regime: input.regime,
        },
      ],
    };

    await this.logDecision(ctx, input, output, "Evaluated execution quality and emitted calibration signals for reliability updates.");
    return output;
  }
}
