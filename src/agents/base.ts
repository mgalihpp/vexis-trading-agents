import type { Agent, AgentContext, EventStore, JSONValue } from "../types";
import { appendLog } from "../core/pipeline";

export abstract class BaseAgent<I extends JSONValue, O extends JSONValue> implements Agent<I, O> {
  public abstract readonly name: string;

  protected constructor(protected readonly eventStore: EventStore) {}

  public abstract run(input: I, ctx: AgentContext): Promise<O>;

  protected async logDecision(
    ctx: AgentContext,
    input: I,
    output: O,
    rationale: string,
    source: "llm" | "fallback" | "system" = "fallback",
    retries = 0
  ): Promise<void> {
    await appendLog(this.eventStore, ctx.runId, ctx.traceId, this.name, ctx.nowIso(), input, output, rationale, source, retries);
  }
}
