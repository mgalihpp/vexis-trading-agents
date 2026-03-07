import type {
  DecisionLogEntry,
  ExecutionDecision,
  MarketDataQuery,
  OutputFormat,
  PipelineMode,
} from "../types";

interface RunResultLike {
  executionDecision: ExecutionDecision;
  logs: DecisionLogEntry[];
  executionReport?: unknown;
  postTradeEvaluation?: unknown;
}

export interface PrintRunReportInput {
  runId: string;
  mode: PipelineMode;
  query: MarketDataQuery;
  result: RunResultLike;
  outputFormat?: OutputFormat;
}

const toJson = (value: unknown): string => JSON.stringify(value, null, 2);

const conciseLine = (event: DecisionLogEntry): string =>
  `${event.timestamp} [${event.source.toUpperCase()}] ${event.agent} :: ${event.decisionRationale}`;

export const formatStreamEvent = (event: DecisionLogEntry): string => conciseLine(event);

export const formatChatStyleRunReport = (input: PrintRunReportInput): string => {
  const lines: string[] = [];
  const d = input.result.executionDecision;
  lines.push(`Run ${input.runId} (${input.mode}) ${input.query.asset} ${input.query.timeframe}`);
  lines.push(
    `Execution venue=${d.execution_venue} portfolio_approved=${String(d.portfolio_approved)} executable=${String(d.executable)} notional=${d.approved_notional_usd}`,
  );
  lines.push(
    `Risk budget=${d.risk_budget_usd ?? "-"} effective_risk=${d.effective_risk_usd ?? "-"} leverage=${d.leverage_used ?? "-"} required_margin=${d.required_margin_usd ?? "-"}`,
  );
  if (d.execution_blocker) lines.push(`Blocker ${d.execution_blocker}`);
  if (d.reasons.length > 0) lines.push(`Reasons ${d.reasons.join(" | ")}`);
  for (const log of input.result.logs) {
    lines.push(`- ${conciseLine(log)}`);
  }
  return lines.join("\n");
};

export const formatPrettyRunReport = (input: PrintRunReportInput): string => formatChatStyleRunReport(input);

export const formatRunnerCycleSummary = (input: PrintRunReportInput): string => {
  const decision = input.result.executionDecision;
  return `[runner] run=${input.runId} asset=${input.query.asset} venue=${decision.execution_venue} approved=${String(decision.portfolio_approved)} executable=${String(decision.executable)} notional=${decision.approved_notional_usd} risk=${decision.effective_risk_usd ?? "-"} blocker=${decision.execution_blocker ?? "-"}`;
};

export const createStreamPrinter = (ctx: {
  runId: string;
  mode: PipelineMode;
  query: MarketDataQuery;
}) => ({
  printHeader: (): void => {
    console.log(`Streaming run ${ctx.runId} (${ctx.mode}) ${ctx.query.asset} ${ctx.query.timeframe}`);
  },
  printEvent: (event: DecisionLogEntry): void => {
    console.log(formatStreamEvent(event));
  },
});

export const printRunReport = (input: PrintRunReportInput): void => {
  const outputFormat = input.outputFormat ?? "pretty";
  if (outputFormat === "json") {
    console.log(toJson(input));
    return;
  }
  console.log(formatPrettyRunReport(input));
};
