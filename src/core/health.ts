import type { AlertEvent, HealthStatus, MetricTags, TelemetrySink } from "../types";

export interface SLOConfig {
  maxP95RunLatencyMs: number;
  maxFallbackRatio: number;
  maxConsecutiveFailures: number;
}

export interface RunHealthSample {
  runId: string;
  traceId: string;
  latencyMs: number;
  fallbackRatio: number;
  success: boolean;
  mode: string;
  asset: string;
  timestamp: string;
}

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
};

export class HealthMonitor {
  private readonly providerHealth = new Map<string, HealthStatus>();
  private llmSuccess = 0;
  private llmTimeout = 0;
  private consecutiveFailures = 0;
  private readonly runs: RunHealthSample[] = [];
  private lastSuccessfulRun: string | undefined;

  public constructor(private readonly sink: TelemetrySink, private readonly slo: SLOConfig) {}

  public recordProviderHealth(status: HealthStatus): void {
    this.providerHealth.set(status.target, status);
  }

  public recordLlmOutcome(ok: boolean, timeout: boolean): void {
    if (ok) this.llmSuccess += 1;
    if (timeout) this.llmTimeout += 1;
  }

  public async recordRun(sample: RunHealthSample): Promise<void> {
    this.runs.push(sample);
    if (sample.success) {
      this.consecutiveFailures = 0;
      this.lastSuccessfulRun = sample.runId;
    } else {
      this.consecutiveFailures += 1;
    }

    const p95 = percentile(this.runs.map((r) => r.latencyMs), 95);
    const tags: MetricTags = {
      run_id: sample.runId,
      trace_id: sample.traceId,
      mode: sample.mode,
      asset: sample.asset
    };

    await this.sink.emitMetric({
      name: "run_latency_ms",
      value: sample.latencyMs,
      timestamp: sample.timestamp,
      tags
    });

    await this.sink.emitMetric({
      name: "run_fallback_ratio",
      value: sample.fallbackRatio,
      timestamp: sample.timestamp,
      tags
    });

    await this.sink.emitMetric({
      name: "run_latency_p95_ms",
      value: p95,
      timestamp: sample.timestamp,
      tags
    });

    if (p95 > this.slo.maxP95RunLatencyMs) {
      await this.emitSloAlert({
        timestamp: sample.timestamp,
        name: "slo_latency_breach",
        severity: "warning",
        trace_id: sample.traceId,
        tags,
        message: `p95 run latency ${p95}ms exceeds threshold ${this.slo.maxP95RunLatencyMs}ms`,
        last_successful_run: this.lastSuccessfulRun
      });
    }

    if (sample.fallbackRatio > this.slo.maxFallbackRatio) {
      await this.emitSloAlert({
        timestamp: sample.timestamp,
        name: "fallback_spike",
        severity: "warning",
        trace_id: sample.traceId,
        tags,
        message: `fallback ratio ${sample.fallbackRatio.toFixed(3)} exceeds threshold ${this.slo.maxFallbackRatio}`,
        last_successful_run: this.lastSuccessfulRun
      });
    }

    if (this.consecutiveFailures >= this.slo.maxConsecutiveFailures) {
      await this.emitSloAlert({
        timestamp: sample.timestamp,
        name: "run_failure_streak",
        severity: "critical",
        trace_id: sample.traceId,
        tags,
        message: `consecutive run failures=${this.consecutiveFailures}`,
        last_successful_run: this.lastSuccessfulRun
      });
    }
  }

  public getSnapshot(nowIso: () => string): HealthStatus[] {
    const providerStatuses = [...this.providerHealth.values()];
    const llmTotal = this.llmSuccess + this.llmTimeout;
    const llmTimeoutRatio = llmTotal === 0 ? 0 : this.llmTimeout / llmTotal;
    providerStatuses.push({
      target: "llm",
      kind: "llm",
      state: llmTimeoutRatio > 0.3 ? "degraded" : "healthy",
      timestamp: nowIso(),
      message: `llm success=${this.llmSuccess} timeout=${this.llmTimeout}`,
      tags: {
        llm_success: this.llmSuccess,
        llm_timeout: this.llmTimeout,
        llm_timeout_ratio: Number(llmTimeoutRatio.toFixed(4))
      }
    });

    return providerStatuses;
  }

  public async emitProviderFailureAlert(args: {
    traceId: string;
    runId: string;
    provider: string;
    code: string;
    message: string;
    timestamp: string;
    mode: string;
    asset: string;
  }): Promise<void> {
    await this.sink.emitAlert({
      timestamp: args.timestamp,
      name: "provider_fail_hard",
      severity: "critical",
      trace_id: args.traceId,
      provider: args.provider,
      error_code: args.code,
      tags: {
        run_id: args.runId,
        mode: args.mode,
        asset: args.asset,
        provider: args.provider
      },
      message: args.message,
      last_successful_run: this.lastSuccessfulRun
    });
  }

  private async emitSloAlert(event: AlertEvent): Promise<void> {
    await this.sink.emitAlert(event);
  }
}
