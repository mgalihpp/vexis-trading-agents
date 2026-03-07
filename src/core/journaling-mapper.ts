import { tradeSchema } from "../utils/schema/trade";
import type {
  ExecutionDecision,
  ExecutionReport,
  JournalingRule,
  PipelineMode,
  RiskDecision,
  TradeProposal,
} from "../types";

const tradePatchSchema = tradeSchema.partial();

const toNum = (value: number | null | undefined, digits = 4): string | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value.toFixed(digits);
};

const toUiTimeframe = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  const map: Record<string, string> = {
    "1m": "M1",
    "3m": "M3",
    "5m": "M5",
    "15m": "M15",
    "30m": "M30",
    "1h": "H1",
    "2h": "H2",
    "4h": "H4",
    "8h": "H8",
    "1d": "D1",
    "1w": "W1",
  };
  return map[normalized] ?? value.toUpperCase();
};

const sessionFromIso = (iso: string): string => {
  const hour = new Date(iso).getUTCHours();
  if (Number.isNaN(hour)) return "Asia";
  if (hour >= 0 && hour < 6) return "Asia";
  if (hour >= 6 && hour < 7) return "Pre-London";
  if (hour >= 7 && hour < 12) return "London";
  if (hour >= 12 && hour < 16) return "Overlap";
  if (hour >= 16 && hour < 21) return "New York";
  return "Post-NY";
};

const tradeTypeFromTimeframe = (timeframe: string): string => {
  const tf = timeframe.trim().toUpperCase();
  if (["M1", "M3", "M5", "M15"].includes(tf)) return "Scalp";
  if (["M30", "H1", "H2", "H4", "H8"].includes(tf)) return "Day Trade";
  if (tf === "D1") return "Swing";
  if (tf === "W1") return "Position";
  return "Day Trade";
};

const rrToPreset = (rr: number): string => {
  const presets = [1, 1.5, 2, 2.5, 3, 4, 5];
  const safe = Number.isFinite(rr) && rr > 0 ? rr : 1;
  const nearest = presets.reduce((best, curr) =>
    Math.abs(curr - safe) < Math.abs(best - safe) ? curr : best
  , presets[0]);
  return `1:${nearest}`;
};

const toDateParts = (iso: string): { date: string; time: string; checkedAt: Date } => {
  const parsed = new Date(iso);
  const safe = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const safeIso = safe.toISOString();
  return {
    date: safeIso.slice(0, 10),
    time: safeIso.slice(11, 16),
    checkedAt: safe,
  };
};

export const mapProposalCreated = (input: {
  nowIso: string;
  mode: PipelineMode;
  asset: string;
  timeframe: string;
  proposal: TradeProposal;
  accountBalanceUsd: number;
  checklistRules?: JournalingRule[];
}): Record<string, unknown> => {
  const { date, time, checkedAt } = toDateParts(input.nowIso);
  const [base, quote = "USDT"] = input.asset.split("/");
  const tf = toUiTimeframe(input.timeframe);
  const session = sessionFromIso(input.nowIso);
  const riskDistance = Math.abs(input.proposal.entry - input.proposal.stop_loss);
  const rewardDistance = Math.abs(input.proposal.take_profit - input.proposal.entry);
  const rrRatio = riskDistance > 0 ? rewardDistance / riskDistance : 0;
  const checklist =
    input.checklistRules && input.checklistRules.length > 0
      ? input.checklistRules.map((rule) => ({
          ruleId: rule.ruleId,
          ruleContent: rule.ruleContent,
          isMandatory: rule.isMandatory,
          isChecked: rule.isMandatory ? true : false,
          checkedAt: rule.isMandatory ? checkedAt : null,
        }))
      : undefined;

  const payload = {
    date,
    time,
    market: "Crypto",
    pair: `${base}${quote}`.toUpperCase(),
    timeframe: tf,
    session,
    tradeType: tradeTypeFromTimeframe(tf),
    direction: input.proposal.side === "long" ? "Long" : "Short",
    marketCondition: "Trending",
    marketBias: input.proposal.side === "long" ? "Bullish" : "Bearish",
    strategy: "Trend Following",
    setup: "Pullback",
    technicalConfirmation: "Support/Resistance",
    entryReason: input.proposal.reasoning,
    entryPrice: toNum(input.proposal.entry),
    stopLoss: toNum(input.proposal.stop_loss),
    takeProfit: toNum(input.proposal.take_profit),
    accountBalance: toNum(input.accountBalanceUsd, 2),
    rrRatio: rrToPreset(rrRatio),
    confidence: 7,
    discipline: 7,
    result: "Pending",
    tags: ["ai", "pipeline", base.toUpperCase(), quote.toUpperCase()],
    checklist,
  };
  return tradeSchema.parse(payload);
};

export const mapRiskEvaluated = (input: {
  proposal: TradeProposal;
  risk: RiskDecision;
}): Record<string, unknown> =>
  tradePatchSchema.parse({
    riskPercent: toNum(input.risk.adjusted_position_size_pct, 3),
    stopLoss: toNum(input.proposal.stop_loss),
    positionSize: toNum(input.risk.adjusted_position_size_pct, 3),
    notes: `Risk score=${toNum(input.risk.risk_score, 2)} approved=${String(input.risk.approved)} reasons=${input.risk.reasons.join(" | ")}`,
  });

export const mapExecutionDecided = (input: {
  decision: ExecutionDecision;
  report?: ExecutionReport;
  proposal: TradeProposal;
}): Record<string, unknown> => {
  const result = input.decision.approve ? "Approved" : "Rejected";
  const pnl = input.report?.pnl?.totalUsd ?? 0;
  const plannedRisk = Math.abs(input.proposal.entry - input.proposal.stop_loss);
  const plannedReward = Math.abs(input.proposal.take_profit - input.proposal.entry);
  const actualRR = plannedRisk > 0 ? plannedReward / plannedRisk : 0;
  const whatWentRight = input.decision.approve
    ? "Execution approved by portfolio and risk controls."
    : "";
  const mistakes = input.decision.approve
    ? ""
    : "Allocation rejected or guarded by risk/portfolio hard checks.";
  return tradePatchSchema.parse({
    result,
    profitLoss: toNum(pnl, 4),
    actualRR: toNum(actualRR, 2),
    lesson: input.decision.reasons.join(" | "),
    whatWentRight,
    mistakes,
    notes: `Execution decision=${result}; filled=${String(input.report?.filled ?? false)}`,
  });
};

export const mapRunSummary = (input: {
  approved: boolean;
  reasons: string[];
  traceId: string;
  runId: string;
  mode: PipelineMode;
  asset: string;
}): Record<string, unknown> =>
  tradePatchSchema.parse({
    notes: `Run ${input.runId} completed. trace=${input.traceId}. decision=${input.approved ? "approved" : "rejected"}.`,
    tags: ["summary", input.mode, input.asset.replace("/", "_").toUpperCase()],
    improvement: input.approved
      ? "Monitor post-trade performance and tighten exits if volatility rises."
      : "Adjust sizing/entry rules to pass risk + portfolio guards.",
    actionPlan: input.reasons.length > 0
      ? `Review reasons: ${input.reasons.join(" | ")}`
      : "No additional action.",
  });
