import type {
  AgentMessageView,
  DecisionLogEntry,
  ExecutionDecision,
  JSONValue,
  MarketDataQuery,
  OutputFormat,
  PipelineMode,
  RunReportSection
} from "../types";

interface RunResultLike {
  executionDecision: ExecutionDecision;
  logs: DecisionLogEntry[];
  executionReport?: unknown;
}

export interface PrintRunReportInput {
  runId: string;
  mode: PipelineMode;
  query: MarketDataQuery;
  result: RunResultLike;
  outputFormat?: OutputFormat;
}

interface SummaryOptions {
  maxDepth: number;
  maxArrayItems: number;
  maxObjectKeys: number;
}

const defaultSummaryOptions: SummaryOptions = {
  maxDepth: 3,
  maxArrayItems: 5,
  maxObjectKeys: 10
};

const sourceBadge = (source: DecisionLogEntry["source"]): string => {
  if (source === "llm") return "[LLM]";
  if (source === "fallback") return "[FALLBACK]";
  return "[SYSTEM]";
};

const summarizeJson = (value: unknown, depth: number, options: SummaryOptions): JSONValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    if (depth >= options.maxDepth) {
      return [`[truncated array; length=${value.length}]`];
    }

    const head = value
      .slice(0, options.maxArrayItems)
      .map((item) => summarizeJson(item, depth + 1, options));

    if (value.length > options.maxArrayItems) {
      head.push(`[...${value.length - options.maxArrayItems} more items]`);
    }

    return head;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);

    if (depth >= options.maxDepth) {
      return { __truncated_object__: true, keys: entries.length };
    }

    const sliced = entries.slice(0, options.maxObjectKeys);
    const out: Record<string, JSONValue> = {};

    for (const [key, val] of sliced) {
      out[key] = summarizeJson(val, depth + 1, options);
    }

    if (entries.length > options.maxObjectKeys) {
      out.__truncated_keys__ = entries.length - options.maxObjectKeys;
    }

    return out;
  }

  return String(value);
};

const toNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
};

const toString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const formatNum = (value: unknown, digits = 3): string => {
  const n = toNumber(value);
  if (n === null) return "n/a";
  return n.toFixed(digits);
};

const extractBullets = (agent: string, output: Record<string, unknown>, rationale: string): { headline: string; bullets: string[] } => {
  switch (agent) {
    case "MarketData": {
      return {
        headline: "Market snapshot loaded",
        bullets: [
          `asset=${toString(output.asset) ?? "n/a"} lastPrice=${formatNum(output.lastPrice, 2)}`,
          `candles=${Array.isArray(output.candles) ? output.candles.length : 0}`
        ]
      };
    }
    case "FundamentalsAnalyst": {
      const redFlags = Array.isArray(output.red_flags) ? output.red_flags : [];
      return {
        headline: `Valuation bias: ${toString(output.intrinsic_valuation_bias) ?? "n/a"}`,
        bullets: [`confidence=${formatNum(output.confidence)}`, `red_flags=${redFlags.length}`]
      };
    }
    case "SentimentAnalyst": {
      return {
        headline: `Sentiment: ${toString(output.mood) ?? "n/a"}`,
        bullets: [
          `score=${formatNum(output.sentiment_score)}`,
          `confidence=${formatNum(output.confidence)}`
        ]
      };
    }
    case "NewsAnalyst": {
      return {
        headline: `News impact: ${toString(output.event_impact) ?? "n/a"}`,
        bullets: [
          `severity=${formatNum(output.severity)}`,
          `confidence=${formatNum(output.confidence)}`
        ]
      };
    }
    case "TechnicalAnalyst": {
      const indicators = asObject(output.indicators);
      return {
        headline: `Technical signal: ${toString(output.signal) ?? "n/a"} (${toString(output.trend) ?? "n/a"})`,
        bullets: [
          `rsi=${formatNum(indicators.rsi, 2)} atr=${formatNum(indicators.atr, 2)}`,
          `confidence=${formatNum(output.confidence)}`
        ]
      };
    }
    case "BullishResearcher": {
      const args = Array.isArray(output.bullish_arguments) ? output.bullish_arguments : [];
      return {
        headline: "Bullish thesis prepared",
        bullets: [
          `top_argument=${toString(args[0]) ?? "n/a"}`,
          `reward_est=${formatNum(output.reward_estimate_pct, 2)}%`
        ]
      };
    }
    case "BearishResearcher": {
      const args = Array.isArray(output.bearish_arguments) ? output.bearish_arguments : [];
      return {
        headline: "Bearish thesis prepared",
        bullets: [
          `top_argument=${toString(args[0]) ?? "n/a"}`,
          `confidence=${formatNum(output.confidence)}`
        ]
      };
    }
    case "DebateSynthesizer": {
      return {
        headline: `Debate final bias: ${toString(output.final_bias) ?? "n/a"}`,
        bullets: [`confidence=${formatNum(output.confidence)}`]
      };
    }
    case "TraderAgent": {
      return {
        headline: `Trade proposal: ${toString(output.side) ?? "n/a"} ${toString(output.asset) ?? "n/a"}`,
        bullets: [
          `entry=${formatNum(output.entry, 2)} sl=${formatNum(output.stop_loss, 2)} tp=${formatNum(output.take_profit, 2)}`,
          `size=${formatNum(output.position_size_pct, 2)}%`
        ]
      };
    }
    case "RiskManager": {
      return {
        headline: `Risk gate: ${output.approved === true ? "approved" : "rejected"}`,
        bullets: [
          `risk_score=${formatNum(output.risk_score, 2)}`,
          `adj_size=${formatNum(output.adjusted_position_size_pct, 2)}%`
        ]
      };
    }
    case "PortfolioManager": {
      return {
        headline: `Portfolio decision: ${output.approve === true ? "approve" : "reject"}`,
        bullets: [`capital=${formatNum(output.capital_allocated, 2)}`]
      };
    }
    case "SimulatedExchange": {
      const pnl = asObject(output.pnl);
      return {
        headline: `Execution: ${output.filled === true ? "filled" : "no-fill"}`,
        bullets: [
          `fill_price=${formatNum(output.fillPrice, 2)}`,
          `pnl_total=${formatNum(pnl.totalUsd, 2)}`
        ]
      };
    }
    default:
      return {
        headline: rationale,
        bullets: []
      };
  }
};

const chooseMoreInformative = (a: DecisionLogEntry, b: DecisionLogEntry): DecisionLogEntry => {
  const score = (log: DecisionLogEntry): number => {
    const reasonLen = (log.decisionRationale ?? "").length;
    const outputSize = JSON.stringify(log.outputPayload ?? {}).length;
    return reasonLen + outputSize + log.retries * 5;
  };
  return score(a) >= score(b) ? a : b;
};

const dedupeLogs = (logs: DecisionLogEntry[]): DecisionLogEntry[] => {
  const sorted = [...logs].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const byAgent = new Map<string, DecisionLogEntry>();

  for (const log of sorted) {
    const existing = byAgent.get(log.agent);
    if (!existing) {
      byAgent.set(log.agent, log);
      continue;
    }

    if (log.source === "fallback" || existing.source === "fallback") {
      byAgent.set(log.agent, chooseMoreInformative(existing, log));
      continue;
    }

    if (log.source === "llm" && existing.source !== "llm") {
      byAgent.set(log.agent, log);
      continue;
    }
  }

  return [...byAgent.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
};

export const buildRunReportSections = (logs: DecisionLogEntry[]): RunReportSection[] => {
  return [...logs]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .map((log) => ({
      agent: log.agent,
      time: log.timestamp,
      source: log.source,
      retries: log.retries,
      rationale: log.decisionRationale,
      input_summary: summarizeJson(log.inputPayload, 0, defaultSummaryOptions),
      output_summary: summarizeJson(log.outputPayload, 0, defaultSummaryOptions)
    }));
};

const buildAgentViews = (logs: DecisionLogEntry[]): AgentMessageView[] => {
  const deduped = dedupeLogs(logs);
  return deduped.map((log) => {
    const outputObj = asObject(log.outputPayload);
    const extracted = extractBullets(log.agent, outputObj, log.decisionRationale);
    const retryTag = log.retries > 0 ? [`retries=${log.retries}`] : [];

    return {
      agent: log.agent,
      source: log.source,
      retries: log.retries,
      timestamp: log.timestamp,
      headline: extracted.headline,
      bullets: [...extracted.bullets, ...retryTag, `rationale=${log.decisionRationale}`]
    };
  });
};

export const formatChatStyleRunReport = (input: PrintRunReportInput): string => {
  const sections = buildAgentViews(input.result.logs);
  const lines: string[] = [];

  lines.push("=== Multi-Agent Trading Run Report ===");
  lines.push(`run_id: ${input.runId}`);
  lines.push(`mode: ${input.mode}`);
  lines.push(`asset/timeframe: ${input.query.asset} / ${input.query.timeframe}`);
  lines.push(`agent_messages: ${sections.length}`);
  lines.push("");
  lines.push("--- Agent Messages ---");

  for (const section of sections) {
    lines.push(`${sourceBadge(section.source)} ${section.timestamp} | ${section.agent}`);
    lines.push(`  ${section.headline}`);
    for (const bullet of section.bullets.slice(0, 4)) {
      lines.push(`  - ${bullet}`);
    }
  }

  lines.push("");
  lines.push("--- Final Execution Decision ---");
  lines.push(JSON.stringify(input.result.executionDecision, null, 2));

  return lines.join("\n");
};

export const formatPrettyRunReport = (input: PrintRunReportInput): string => {
  const sections = buildRunReportSections(input.result.logs);
  const lines: string[] = [];

  lines.push("=== Multi-Agent Trading Run Report (Legacy) ===");
  lines.push(`run_id: ${input.runId}`);
  lines.push(`mode: ${input.mode}`);
  lines.push(`asset/timeframe: ${input.query.asset} / ${input.query.timeframe}`);
  lines.push(`events: ${sections.length}`);
  lines.push("");
  lines.push("--- Agent Trace ---");

  for (const [index, section] of sections.entries()) {
    lines.push(`[${index + 1}] ${section.time} | ${section.agent}`);
    lines.push(`  source=${section.source} retries=${section.retries}`);
    lines.push(`  rationale=${section.rationale}`);
    lines.push(`  input=${JSON.stringify(section.input_summary)}`);
    lines.push(`  output=${JSON.stringify(section.output_summary)}`);
  }

  lines.push("");
  lines.push("--- Final Execution Decision ---");
  lines.push(JSON.stringify(input.result.executionDecision, null, 2));

  return lines.join("\n");
};

export const printRunReport = (input: PrintRunReportInput): void => {
  const format = input.outputFormat ?? "pretty";
  if (format === "json") {
    console.log(
      JSON.stringify(
        {
          runId: input.runId,
          mode: input.mode,
          query: input.query,
          result: input.result
        },
        null,
        2
      )
    );
    return;
  }

  console.log(formatChatStyleRunReport(input));
};
