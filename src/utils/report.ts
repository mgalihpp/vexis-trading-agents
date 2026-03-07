import type {
  AgentMessageView,
  DecisionLogEntry,
  ExecutionDecision,
  JSONValue,
  MarketDataQuery,
  OutputFormat,
  PipelineMode,
  RunReportSection,
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

interface StreamRenderOptions {
  useColor?: boolean;
}

interface ColorPalette {
  dim: string;
  reset: string;
  cyan: string;
  yellow: string;
  gray: string;
  blue: string;
  green: string;
  magenta: string;
  red: string;
  bold: string;
}

const COLOR: ColorPalette = {
  dim: "\x1b[2m",
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
  bold: "\x1b[1m",
};

const defaultSummaryOptions: SummaryOptions = {
  maxDepth: 3,
  maxArrayItems: 5,
  maxObjectKeys: 10,
};

const shouldUseColor = (options?: StreamRenderOptions): boolean => {
  if (options?.useColor !== undefined) return options.useColor;
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
};

const paint = (value: string, code: string, enabled: boolean): string => {
  if (!enabled) return value;
  return `${code}${value}${COLOR.reset}`;
};

const sourceBadge = (source: DecisionLogEntry["source"]): string => {
  if (source === "llm") return "LLM";
  if (source === "fallback") return "FALLBACK";
  return "SYSTEM";
};

const formatReadableTimestamp = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absOffset / 60)).padStart(2, "0");
  const offsetMins = String(absOffset % 60).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} UTC${sign}${offsetHours}:${offsetMins}`;
};

const summarizeJson = (
  value: unknown,
  depth: number,
  options: SummaryOptions,
): JSONValue => {
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

const toString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const formatNum = (value: unknown, digits = 3): string => {
  const n = toNumber(value);
  if (n === null) return "n/a";
  return n.toFixed(digits);
};

const extractBullets = (
  agent: string,
  output: Record<string, unknown>,
  rationale: string,
): { headline: string; bullets: string[] } => {
  switch (agent) {
    case "MarketData": {
      return {
        headline: "Market snapshot loaded",
        bullets: [
          `asset=${toString(output.asset) ?? "n/a"} lastPrice=${formatNum(output.lastPrice, 2)}`,
          `candles=${Array.isArray(output.candles) ? output.candles.length : 0}`,
        ],
      };
    }
    case "DataProviderStatus": {
      return {
        headline: `Provider ${toString(output.provider) ?? "unknown"}`,
        bullets: [
          `ok=${String(output.ok ?? "n/a")} status=${String(output.statusCode ?? "n/a")}`,
          `latency_ms=${formatNum(output.latencyMs, 0)} records=${String(output.recordCount ?? "n/a")}`,
        ],
      };
    }
    case "FundamentalsAnalyst": {
      const redFlags = Array.isArray(output.red_flags) ? output.red_flags : [];
      return {
        headline: `Valuation bias: ${toString(output.intrinsic_valuation_bias) ?? "n/a"}`,
        bullets: [
          `confidence=${formatNum(output.confidence)}`,
          `red_flags=${redFlags.length}`,
        ],
      };
    }
    case "SentimentAnalyst": {
      return {
        headline: `Sentiment: ${toString(output.mood) ?? "n/a"}`,
        bullets: [
          `score=${formatNum(output.sentiment_score)}`,
          `confidence=${formatNum(output.confidence)}`,
        ],
      };
    }
    case "NewsAnalyst": {
      return {
        headline: `News impact: ${toString(output.event_impact) ?? "n/a"}`,
        bullets: [
          `severity=${formatNum(output.severity)}`,
          `confidence=${formatNum(output.confidence)}`,
        ],
      };
    }
    case "TechnicalAnalyst": {
      const signals = asObject(output.signals);
      const regime = asObject(output.regime);
      return {
        headline: `Technical v2: ${toString(signals.direction) ?? "n/a"} (regime=${toString(regime.state) ?? "n/a"})`,
        bullets: [
          `prob=${formatNum(signals.calibrated_probability, 3)} conf=${toString(signals.confidence_bucket) ?? "n/a"}`,
          `shadow_agreement=${String(asObject(output.shadow).agreement ?? "n/a")}`,
        ],
      };
    }
    case "BullishResearcher": {
      const args = Array.isArray(output.arguments)
        ? output.arguments
        : [];
      return {
        headline: "Bullish thesis prepared",
        bullets: [
          `top_argument=${toString(args[0]) ?? "n/a"}`,
          `est=${formatNum(output.risk_or_reward_estimate_pct, 2)}%`,
        ],
      };
    }
    case "BearishResearcher": {
      const args = Array.isArray(output.arguments)
        ? output.arguments
        : [];
      return {
        headline: "Bearish thesis prepared",
        bullets: [
          `top_argument=${toString(args[0]) ?? "n/a"}`,
          `est=${formatNum(output.risk_or_reward_estimate_pct, 2)}%`,
        ],
      };
    }
    case "DebateSynthesizer": {
      return {
        headline: `Debate final bias: ${toString(output.final_bias) ?? "n/a"}`,
        bullets: [`confidence=${formatNum(output.confidence)}`],
      };
    }
    case "TraderAgent": {
      return {
        headline: `Trade proposal: ${toString(output.side) ?? "n/a"} ${toString(output.asset) ?? "n/a"}`,
        bullets: [
          `entry=${formatNum(output.entry, 2)} sl=${formatNum(output.stop_loss, 2)} tp=${formatNum(output.take_profit, 2)}`,
          `size=${formatNum(output.position_size_pct, 2)}%`,
        ],
      };
    }
    case "RiskManager": {
      return {
        headline: `Risk gate: ${output.approved === true ? "approved" : "rejected"}`,
        bullets: [
          `risk_score=${formatNum(output.risk_score, 2)}`,
          `adj_size=${formatNum(output.adjusted_position_size_pct, 2)}%`,
        ],
      };
    }
    case "PortfolioManager": {
      return {
        headline: `Portfolio decision: ${output.approve === true ? "approve" : "reject"}`,
        bullets: [`capital=${formatNum(output.capital_allocated, 2)}`],
      };
    }
    case "SimulatedExchange": {
      const pnl = asObject(output.pnl);
      return {
        headline: `Execution: ${output.filled === true ? "filled" : "no-fill"}`,
        bullets: [
          `fill_price=${formatNum(output.fillPrice, 2)}`,
          `pnl_total=${formatNum(pnl.totalUsd, 2)}`,
        ],
      };
    }
    default:
      return {
        headline: rationale,
        bullets: [],
      };
  }
};

const toAgentView = (log: DecisionLogEntry): AgentMessageView => {
  const outputObj = asObject(log.outputPayload);
  const extracted = extractBullets(log.agent, outputObj, log.decisionRationale);
  const retryTag = log.retries > 0 ? [`retries=${log.retries}`] : [];

  return {
    agent: log.agent,
    source: log.source,
    retries: log.retries,
    timestamp: log.timestamp,
    headline: extracted.headline,
    bullets: [
      ...extracted.bullets,
      ...retryTag,
      `rationale=${log.decisionRationale}`,
    ],
  };
};

const chooseMoreInformative = (
  a: DecisionLogEntry,
  b: DecisionLogEntry,
): DecisionLogEntry => {
  const score = (log: DecisionLogEntry): number => {
    const reasonLen = (log.decisionRationale ?? "").length;
    const outputSize = JSON.stringify(log.outputPayload ?? {}).length;
    return reasonLen + outputSize + log.retries * 5;
  };
  return score(a) >= score(b) ? a : b;
};

const dedupeLogs = (logs: DecisionLogEntry[]): DecisionLogEntry[] => {
  const sorted = [...logs].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );
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

  return [...byAgent.values()].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );
};

export const buildRunReportSections = (
  logs: DecisionLogEntry[],
): RunReportSection[] => {
  return [...logs]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .map((log) => ({
      agent: log.agent,
      time: log.timestamp,
      source: log.source,
      retries: log.retries,
      rationale: log.decisionRationale,
      input_summary: summarizeJson(log.inputPayload, 0, defaultSummaryOptions),
      output_summary: summarizeJson(
        log.outputPayload,
        0,
        defaultSummaryOptions,
      ),
    }));
};

const buildAgentViews = (logs: DecisionLogEntry[]): AgentMessageView[] => {
  const deduped = dedupeLogs(logs);
  return deduped.map((log) => toAgentView(log));
};

export const formatStreamHeader = (
  input: {
    runId: string;
    mode: PipelineMode;
    query: MarketDataQuery;
  },
  options?: StreamRenderOptions,
): string => {
  const color = shouldUseColor(options);
  const title = paint("VEXIS CLI", `${COLOR.bold}${COLOR.blue}`, color);
  const meta = `${paint("run", COLOR.dim, color)}=${input.runId}  ${paint("mode", COLOR.dim, color)}=${input.mode}  ${paint("pair", COLOR.dim, color)}=${input.query.asset}  ${paint("timeframe", COLOR.dim, color)}=${input.query.timeframe}`;
  return `${title}\n${meta}`;
};

export const formatStreamEvent = (
  event: DecisionLogEntry,
  options?: StreamRenderOptions,
): string => {
  const color = shouldUseColor(options);
  const view = toAgentView(event);
  const badgeColor =
    event.source === "llm"
      ? COLOR.cyan
      : event.source === "fallback"
        ? COLOR.yellow
        : COLOR.gray;
  const badge = paint(`[${sourceBadge(event.source)}]`, badgeColor, color);
  const agent = paint(view.agent, `${COLOR.bold}${COLOR.magenta}`, color);
  const ts = paint(formatReadableTimestamp(view.timestamp), COLOR.dim, color);

  const lines = [`${badge} ${ts} ${agent}`, `  ${view.headline}`];
  for (const bullet of view.bullets.slice(0, 4)) {
    lines.push(`  - ${bullet}`);
  }
  return lines.join("\n");
};

export const formatFinalOutcome = (
  input: PrintRunReportInput,
  options?: StreamRenderOptions,
): string => {
  const color = shouldUseColor(options);
  const decision = input.result.executionDecision;
  const exec = asObject(input.result.executionReport);
  const pnl = asObject(exec.pnl);
  const instructions = asObject(decision.execution_instructions);
  const reasons = Array.isArray(decision.reasons)
    ? decision.reasons.filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      )
    : [];

  const decisionTitle = paint("Decision", `${COLOR.bold}${COLOR.green}`, color);
  const executionTitle = paint(
    "Execution",
    `${COLOR.bold}${COLOR.green}`,
    color,
  );
  const capitalTitle = paint(
    "Risk/Capital",
    `${COLOR.bold}${COLOR.green}`,
    color,
  );

  const lines: string[] = [];
  lines.push("");
  lines.push(`${decisionTitle}`);
  lines.push(
    `  approve=${String(decision.approve)} capital_allocated=${formatNum(decision.capital_allocated, 2)}`,
  );
  lines.push(`  reason_count=${reasons.length}`);
  if (reasons.length > 0) {
    lines.push(`  top_reason=${reasons[0]}`);
    for (const reason of reasons.slice(0, 3)) {
      lines.push(`  - ${reason}`);
    }
  }
  lines.push(`${capitalTitle}`);
  lines.push(
    `  side=${toString(instructions.side) ?? "n/a"} type=${toString(instructions.type) ?? "n/a"} tif=${toString(instructions.tif) ?? "n/a"}`,
  );
  lines.push(
    `  quantity_notional_usd=${formatNum(instructions.quantity_notional_usd, 2)}`,
  );
  lines.push(`${executionTitle}`);
  lines.push(
    `  filled=${String(exec.filled ?? false)} fill_price=${formatNum(exec.fillPrice, 2)} pnl_total=${formatNum(pnl.totalUsd, 2)}`,
  );
  lines.push(`  trace_events=${input.result.logs.length}`);
  return lines.join("\n");
};

export const formatRunnerCycleSummary = (
  input: PrintRunReportInput,
): string => {
  const decision = input.result.executionDecision;
  const side =
    toString(asObject(decision.execution_instructions).side) ?? "n/a";
  const status = decision.approve ? "approved" : "rejected";
  const fallbackCount = input.result.logs.filter(
    (log) => log.source === "fallback",
  ).length;
  return [
    `[RUNNER] run=${input.runId} mode=${input.mode} pair=${input.query.asset}/${input.query.timeframe}`,
    `  status=${status} side=${side} capital=${formatNum(decision.capital_allocated, 2)}`,
    `  events=${input.result.logs.length} fallbacks=${fallbackCount}`,
  ].join("\n");
};

export const createStreamPrinter = (
  input: {
    runId: string;
    mode: PipelineMode;
    query: MarketDataQuery;
  },
  options?: StreamRenderOptions,
): {
  printHeader: () => void;
  printEvent: (event: DecisionLogEntry) => void;
} => {
  let printed = false;

  return {
    printHeader: () => {
      if (printed) return;
      printed = true;
      console.log(formatStreamHeader(input, options));
    },
    printEvent: (event: DecisionLogEntry) => {
      if (!printed) {
        printed = true;
        console.log(formatStreamHeader(input, options));
      }
      console.log(formatStreamEvent(event, options));
    },
  };
};

export const formatChatStyleRunReport = (
  input: PrintRunReportInput,
): string => {
  const sections = buildAgentViews(input.result.logs);
  const lines: string[] = [];

  lines.push("=== Multi-Agent Trading Run Report ===");
  lines.push(`run_id: ${input.runId}`);
  lines.push(`mode: ${input.mode}`);
  lines.push(
    `asset/timeframe: ${input.query.asset} / ${input.query.timeframe}`,
  );
  lines.push(`agent_messages: ${sections.length}`);
  lines.push("");
  lines.push("--- Agent Messages ---");

  for (const section of sections) {
    lines.push(
      `[${sourceBadge(section.source)}] ${formatReadableTimestamp(section.timestamp)} | ${section.agent}`,
    );
    lines.push(`  ${section.headline}`);
    for (const bullet of section.bullets.slice(0, 4)) {
      lines.push(`  - ${bullet}`);
    }
  }

  lines.push(formatFinalOutcome(input, { useColor: false }));
  return lines.join("\n");
};

export const formatPrettyRunReport = (input: PrintRunReportInput): string => {
  const sections = buildRunReportSections(input.result.logs);
  const lines: string[] = [];

  lines.push("=== Multi-Agent Trading Run Report (Legacy) ===");
  lines.push(`run_id: ${input.runId}`);
  lines.push(`mode: ${input.mode}`);
  lines.push(
    `asset/timeframe: ${input.query.asset} / ${input.query.timeframe}`,
  );
  lines.push(`events: ${sections.length}`);
  lines.push("");
  lines.push("--- Agent Trace ---");

  for (const [index, section] of sections.entries()) {
    lines.push(`[${index + 1}] ${formatReadableTimestamp(section.time)} | ${section.agent}`);
    lines.push(`  source=${section.source} retries=${section.retries}`);
    lines.push(`  rationale=${section.rationale}`);
    lines.push(`  input=${JSON.stringify(section.input_summary)}`);
    lines.push(`  output=${JSON.stringify(section.output_summary)}`);
  }

  lines.push(formatFinalOutcome(input, { useColor: false }));
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
          result: input.result,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(formatFinalOutcome(input));
};
