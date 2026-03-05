import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import type { z } from "zod";
import type { HealthMonitor } from "./health";
import { withTimeout } from "./ops";
import type { LLMNodeConfig, LLMRunnerResult, MetricTags, TelemetrySink } from "../types";

const noopTelemetrySink: TelemetrySink = {
  emitLog: async () => undefined,
  emitMetric: async () => undefined,
  emitAlert: async () => undefined
};

export interface LLMRunnerDeps {
  baseUrl: string;
  apiKey: string;
  model: string;
  defaultMaxRetries: number;
  timeoutMs?: number;
  telemetrySink?: TelemetrySink;
  healthMonitor?: HealthMonitor;
}

export class LLMRunner {
  private readonly model: ChatOpenAI;
  private readonly defaultMaxRetries: number;
  private readonly timeoutMs: number;
  private readonly telemetrySink: TelemetrySink;

  public constructor(private readonly deps: LLMRunnerDeps) {
    this.model = new ChatOpenAI({
      model: deps.model,
      configuration: {
        baseURL: deps.baseUrl,
        apiKey: deps.apiKey
      },
      temperature: 0
    });
    this.defaultMaxRetries = deps.defaultMaxRetries;
    this.timeoutMs = deps.timeoutMs ?? 12000;
    this.telemetrySink = deps.telemetrySink ?? noopTelemetrySink;
  }

  public async runWithFallback<T>(args: {
    config: LLMNodeConfig;
    schema: z.ZodSchema<T>;
    systemPrompt: string;
    input: unknown;
    fallback: () => Promise<T>;
    trace?: { traceId: string; runId: string; mode: string; asset: string };
  }): Promise<LLMRunnerResult<T>> {
    const maxRetries = Math.max(0, args.config.maxRetries ?? this.defaultMaxRetries);
    let lastError: unknown = undefined;

    const tags: MetricTags = {
      trace_id: args.trace?.traceId ?? "",
      run_id: args.trace?.runId ?? "",
      mode: args.trace?.mode ?? "",
      asset: args.trace?.asset ?? "",
      node: args.config.nodeName,
      source: "llm",
      provider: "openrouter"
    };

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const startedMs = Date.now();
      try {
        const runnable = this.model.withStructuredOutput(args.schema);
        const response = await withTimeout(
          runnable.invoke([new SystemMessage(args.systemPrompt), new HumanMessage(JSON.stringify(args.input))]),
          this.timeoutMs,
          `LLM_TIMEOUT:${args.config.nodeName}`
        );

        await this.telemetrySink.emitMetric({
          name: "llm_latency_ms",
          value: Date.now() - startedMs,
          timestamp: new Date().toISOString(),
          tags
        });
        await this.telemetrySink.emitMetric({
          name: "llm_error_rate",
          value: 0,
          timestamp: new Date().toISOString(),
          tags
        });

        if (this.deps.healthMonitor) {
          this.deps.healthMonitor.recordLlmOutcome(true, false);
        }

        return {
          output: response,
          source: "llm",
          retries: attempt,
          decisionRationale: "Structured response accepted from LLM"
        };
      } catch (error) {
        lastError = error;
        const isTimeout = String(error).includes("LLM_TIMEOUT");
        await this.telemetrySink.emitMetric({
          name: "llm_error_rate",
          value: 1,
          timestamp: new Date().toISOString(),
          tags
        });
        if (isTimeout) {
          await this.telemetrySink.emitMetric({
            name: "llm_timeout_ratio",
            value: 1,
            timestamp: new Date().toISOString(),
            tags
          });
        }
        if (this.deps.healthMonitor) {
          this.deps.healthMonitor.recordLlmOutcome(false, isTimeout);
        }
      }
    }

    const fallbackOutput = await args.fallback();
    await this.telemetrySink.emitMetric({
      name: "llm_fallback_rate",
      value: 1,
      timestamp: new Date().toISOString(),
      tags: { ...tags, source: "fallback" }
    });

    return {
      output: fallbackOutput,
      source: "fallback",
      retries: maxRetries,
      decisionRationale: `Fallback used after LLM retries exhausted: ${String(lastError)}`
    };
  }
}

export interface DecisionRunner {
  runWithFallback: LLMRunner["runWithFallback"];
}
