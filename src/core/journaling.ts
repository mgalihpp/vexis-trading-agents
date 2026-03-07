import type {
  JournalingClient,
  JournalingRequestMeta,
  JournalingRule,
  TelemetrySink,
} from "../types";
import { withRetry, withTimeout, type RetryPolicyProfile } from "./ops";

const noopTelemetrySink: TelemetrySink = {
  emitLog: async () => undefined,
  emitMetric: async () => undefined,
  emitAlert: async () => undefined,
};

class JournalingHttpError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "JournalingHttpError";
  }
}

export interface HttpJournalingClientConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  retry: RetryPolicyProfile;
  fetchFn?: typeof fetch;
  telemetrySink?: TelemetrySink;
  rulesCacheTtlMs?: number;
}

export class HttpJournalingClient implements JournalingClient {
  private readonly fetchFn: typeof fetch;
  private readonly telemetrySink: TelemetrySink;
  private readonly rulesCacheTtlMs: number;
  private rulesCache: { expiresAt: number; rules: JournalingRule[] } | null = null;

  public constructor(private readonly config: HttpJournalingClientConfig) {
    this.fetchFn = config.fetchFn ?? fetch;
    this.telemetrySink = config.telemetrySink ?? noopTelemetrySink;
    this.rulesCacheTtlMs = Math.max(0, config.rulesCacheTtlMs ?? 60_000);
  }

  public async listTradeRules(meta: JournalingRequestMeta): Promise<JournalingRule[]> {
    this.ensureEnabled();
    const now = Date.now();
    if (this.rulesCache && this.rulesCache.expiresAt > now) {
      return this.rulesCache.rules;
    }
    try {
      const text = await this.requestWithRetry("GET", "/trades/rules", undefined, meta);
      const parsed = this.parseResponseValue(text);
      const rules = this.parseRules(parsed);
      this.rulesCache = {
        expiresAt: now + this.rulesCacheTtlMs,
        rules,
      };
      return rules;
    } catch {
      // Rules endpoint can be unavailable/misconfigured; keep journaling path alive.
      return [];
    }
  }

  public async postTrade(
    payload: Record<string, unknown>,
    meta: JournalingRequestMeta,
  ): Promise<{ id: string }> {
    this.ensureEnabled();
    const responseBody = await this.requestWithRetry(
      "POST",
      "/trades",
      JSON.stringify(payload),
      meta,
    );
    const parsed = this.parseResponseValue(responseBody);
    const parsedObj =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    const id =
      (typeof parsedObj.id === "string" && parsedObj.id) ||
      (typeof parsedObj.tradeId === "string" && parsedObj.tradeId) ||
      (typeof (parsedObj.data as Record<string, unknown> | undefined)?.id === "string"
        ? String((parsedObj.data as Record<string, unknown>).id)
        : "");
    if (!id) {
      throw new JournalingHttpError(
        502,
        "JOURNALING_RESPONSE_INVALID",
        "POST journaling response missing trade id",
      );
    }
    return { id };
  }

  public async patchTrade(
    id: string,
    payload: Record<string, unknown>,
    meta: JournalingRequestMeta,
  ): Promise<void> {
    this.ensureEnabled();
    const safeId = id.trim();
    if (!safeId) {
      throw new JournalingHttpError(400, "JOURNALING_ID_INVALID", "trade id is required");
    }
    await this.requestWithRetry("PATCH", `/trades/${encodeURIComponent(safeId)}`, JSON.stringify(payload), meta);
  }

  private ensureEnabled(): void {
    if (!this.config.enabled) {
      throw new JournalingHttpError(400, "JOURNALING_DISABLED", "journaling is disabled");
    }
  }

  private async requestWithRetry(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body: string | undefined,
    meta: JournalingRequestMeta,
  ): Promise<string> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}${path}`;
    let retryCount = 0;
    const started = Date.now();

    try {
      const text = await withRetry(
        async () => this.requestOnce(url, method, body, meta),
        this.config.retry,
        (error) => this.shouldRetry(error),
        async ({ attempt, nextDelayMs, error }) => {
          retryCount += 1;
          await this.telemetrySink.emitMetric({
            name: "journaling_retry_count",
            value: 1,
            timestamp: new Date().toISOString(),
            tags: this.tags(meta, {
              method,
              attempt,
              next_delay_ms: nextDelayMs,
              error: String(error),
            }),
          });
        },
      );

      await this.telemetrySink.emitMetric({
        name: "journaling_request_latency_ms",
        value: Date.now() - started,
        timestamp: new Date().toISOString(),
        tags: this.tags(meta, { method }),
      });
      await this.telemetrySink.emitMetric({
        name: "journaling_success_rate",
        value: 1,
        timestamp: new Date().toISOString(),
        tags: this.tags(meta, { method, retries: retryCount }),
      });
      return text;
    } catch (error) {
      await this.telemetrySink.emitMetric({
        name: "journaling_request_latency_ms",
        value: Date.now() - started,
        timestamp: new Date().toISOString(),
        tags: this.tags(meta, { method }),
      });
      await this.telemetrySink.emitMetric({
        name: "journaling_success_rate",
        value: 0,
        timestamp: new Date().toISOString(),
        tags: this.tags(meta, { method, retries: retryCount }),
      });
      throw error;
    }
  }

  private async requestOnce(
    url: string,
    method: "GET" | "POST" | "PATCH",
    body: string | undefined,
    meta: JournalingRequestMeta,
  ): Promise<string> {
    const response = await withTimeout(
      this.fetchFn(url, {
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
          "x-api-key": this.config.apiKey,
          "x-idempotency-key": meta.idempotencyKey,
        },
        body,
      }),
      this.config.timeoutMs,
      "JOURNALING_TIMEOUT",
    );

    const responseText = await response.text();
    if (response.status >= 400) {
      throw new JournalingHttpError(
        response.status,
        "JOURNALING_HTTP_ERROR",
        `Journaling ${method} failed (${response.status}): ${responseText || "empty response"}`,
      );
    }
    return responseText;
  }

  private shouldRetry(error: unknown): boolean {
    if (String(error).includes("JOURNALING_TIMEOUT")) return true;
    if (!(error instanceof JournalingHttpError)) return true;
    if (error.statusCode === 408 || error.statusCode === 429) return true;
    if (error.statusCode >= 500) return true;
    return false;
  }

  private parseResponseValue(text: string): unknown {
    if (!text.trim()) return {};
    try {
      const parsed = JSON.parse(text) as unknown;
      return parsed;
    } catch {
      return {};
    }
  }

  private parseRules(payload: unknown): JournalingRule[] {
    const payloadObj =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};
    const candidates = [
      Array.isArray(payload) ? payload : undefined,
      payloadObj.rules,
      payloadObj.data,
      (payloadObj.data as Record<string, unknown> | undefined)?.rules,
      payloadObj.items,
    ];
    const firstArray = candidates.find((value) => Array.isArray(value));
    const rows = Array.isArray(firstArray) ? firstArray : [];
    return rows
      .map((row): JournalingRule | null => {
        const obj = row as Record<string, unknown>;
        const ruleIdRaw = obj.ruleId ?? obj.id ?? obj._id ?? obj.code;
        const ruleId = typeof ruleIdRaw === "string" ? ruleIdRaw.trim() : "";
        if (!ruleId) return null;
        const contentRaw = obj.ruleContent ?? obj.content ?? obj.title ?? "";
        const ruleContent = typeof contentRaw === "string" ? contentRaw : String(contentRaw);
        const isMandatoryRaw = obj.isMandatory ?? obj.mandatory ?? false;
        const isMandatory = Boolean(isMandatoryRaw);
        return { ruleId, ruleContent, isMandatory };
      })
      .filter((item): item is JournalingRule => Boolean(item));
  }

  private tags(meta: JournalingRequestMeta, extra?: Record<string, string | number>): Record<string, string | number> {
    return {
      trace_id: meta.traceId,
      run_id: meta.runId,
      mode: meta.mode,
      asset: meta.asset,
      node: "JournalingAgent",
      source: "system",
      event_type: meta.eventType,
      ...extra,
    };
  }
}
