import { randomUUID } from "node:crypto";
import type { AlertEvent, OutputFormat, PipelineMode, RunnerConfig, RunnerState } from "../types";
import type { PipelineRunResult, TradingPipeline } from "./pipeline";
import { sleep } from "./ops";

export interface RunnerServiceDeps {
  config: RunnerConfig;
  mode: PipelineMode;
  outputFormat: OutputFormat;
  pipeline: TradingPipeline;
  runInputFactory: (runId: string, traceId: string, mode: PipelineMode) => Promise<{
    runId: string;
    traceId: string;
    mode: PipelineMode;
    query: { asset: string; timeframe: string; limit: number; since?: number | undefined };
    portfolio: {
      equityUsd: number;
      currentExposurePct: number;
      currentDrawdownPct: number;
      liquidityUsd: number;
    };
  }>;
  onCycleResult: (result: PipelineRunResult, state: RunnerState) => Promise<void>;
  onCycleError: (error: unknown, runId: string, traceId: string, state: RunnerState) => Promise<void>;
  onState: (state: RunnerState) => Promise<void>;
  getNewCriticalAlerts: (sinceIndex: number) => { alerts: AlertEvent[]; nextIndex: number };
}

const timeframeToMs = (timeframe: string): number => {
  const m = /^([0-9]+)([mhd])$/.exec(timeframe.trim().toLowerCase());
  if (!m) return 60_000;
  const v = Number.parseInt(m[1] ?? "1", 10);
  const unit = m[2] ?? "m";
  const factor = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return Math.max(60_000, v * factor);
};

const nextCandleBoundaryMs = (nowMs: number, timeframe: string): number => {
  const size = timeframeToMs(timeframe);
  const currentBucket = Math.floor(nowMs / size);
  return (currentBucket + 1) * size;
};

export class RunnerService {
  private stopped = false;
  private backoffLevel = 0;
  private alertCursor = 0;

  public constructor(private readonly deps: RunnerServiceDeps) {}

  public async start(): Promise<void> {
    const state: RunnerState = {
      status: "running",
      backoffLevel: 0,
      currentIntervalSeconds: this.deps.config.intervalSeconds,
      nextRunAtIso: new Date().toISOString(),
      lastRunId: undefined,
      lastTraceId: undefined,
      consecutiveFailures: 0
    };

    this.installSignalHandlers();

    while (!this.stopped) {
      const nowMs = Date.now();
      const nextAt = this.computeNextRunAt(nowMs, this.deps.config.query.timeframe, state.currentIntervalSeconds);
      state.nextRunAtIso = new Date(nextAt).toISOString();
      await this.deps.onState(state);

      const waitMs = Math.max(0, nextAt - nowMs);
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      if (this.stopped) break;

      const runId = `run-${Date.now()}`;
      const traceId = randomUUID();
      state.lastRunId = runId;
      state.lastTraceId = traceId;

      try {
        const runInput = await this.deps.runInputFactory(runId, traceId, this.deps.mode);
        const result = await this.deps.pipeline.runCycle(runInput);

        const { alerts, nextIndex } = this.deps.getNewCriticalAlerts(this.alertCursor);
        this.alertCursor = nextIndex;
        const hasCritical = alerts.some((a) => ["provider_fail_hard", "run_failure_streak"].includes(a.name));

        if (hasCritical) {
          this.backoffLevel += 1;
          state.consecutiveFailures += 1;
        } else {
          this.backoffLevel = 0;
          state.consecutiveFailures = 0;
        }

        state.backoffLevel = this.backoffLevel;
        state.currentIntervalSeconds = this.computeIntervalSeconds(this.backoffLevel);
        await this.deps.onCycleResult(result, state);
      } catch (error) {
        this.backoffLevel += 1;
        state.backoffLevel = this.backoffLevel;
        state.currentIntervalSeconds = this.computeIntervalSeconds(this.backoffLevel);
        state.consecutiveFailures += 1;
        await this.deps.onCycleError(error, runId, traceId, state);
      }
    }

    state.status = "stopped";
    await this.deps.onState(state);
  }

  public stop(): void {
    this.stopped = true;
  }

  private computeIntervalSeconds(backoffLevel: number): number {
    const base = this.deps.config.intervalSeconds;
    const maxSec = this.deps.config.maxBackoffSeconds;
    const candidate = base * Math.pow(2, Math.max(0, backoffLevel));
    return Math.min(maxSec, Math.max(base, Math.round(candidate)));
  }

  private computeNextRunAt(nowMs: number, timeframe: string, intervalSec: number): number {
    const intervalAt = nowMs + intervalSec * 1000;
    if (!this.deps.config.candleAlign) {
      return intervalAt;
    }
    const candleAt = nextCandleBoundaryMs(nowMs, timeframe);
    return Math.min(intervalAt, candleAt);
  }

  private installSignalHandlers(): void {
    const shutdown = () => {
      this.stopped = true;
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
}
