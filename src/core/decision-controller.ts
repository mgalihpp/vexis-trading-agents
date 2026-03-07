import type { ZodTypeAny } from "zod";

export interface StageAuditEntry {
  stage: string;
  startedAt: string;
  finishedAt: string;
  latencyMs: number;
  source: "llm" | "fallback" | "system";
  retries: number;
  validSchema: boolean;
}

export class DecisionController {
  private readonly audits: StageAuditEntry[] = [];

  public validate<T>(schema: ZodTypeAny, payload: unknown): T {
    return schema.parse(payload) as T;
  }

  public record(entry: StageAuditEntry): void {
    this.audits.push(entry);
  }

  public getAuditTrail(): StageAuditEntry[] {
    return [...this.audits];
  }
}
