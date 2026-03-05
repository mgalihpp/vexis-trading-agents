import type { AlertEvent, MetricSample, TelemetryEvent, TelemetrySink } from "../types";

export class InMemoryTelemetrySink implements TelemetrySink {
  private readonly logs: TelemetryEvent[] = [];
  private readonly metrics: MetricSample[] = [];
  private readonly alerts: AlertEvent[] = [];

  public constructor(private readonly mirrorToConsole = false) {}

  public async emitLog(event: TelemetryEvent): Promise<void> {
    this.logs.push(event);
    if (this.mirrorToConsole) {
      console.log(`[telemetry][${event.level}] ${event.message}`);
    }
  }

  public async emitMetric(sample: MetricSample): Promise<void> {
    this.metrics.push(sample);
    if (this.mirrorToConsole) {
      console.log(`[metric] ${sample.name}=${sample.value}`);
    }
  }

  public async emitAlert(event: AlertEvent): Promise<void> {
    this.alerts.push(event);
    if (this.mirrorToConsole) {
      console.error(`[alert][${event.severity}] ${event.name}: ${event.message}`);
    }
  }

  public getLogs(): TelemetryEvent[] {
    return [...this.logs];
  }

  public getMetrics(): MetricSample[] {
    return [...this.metrics];
  }

  public getAlerts(): AlertEvent[] {
    return [...this.alerts];
  }

  public clear(): void {
    this.logs.length = 0;
    this.metrics.length = 0;
    this.alerts.length = 0;
  }
}

export class ConsoleTelemetrySink implements TelemetrySink {
  public async emitLog(event: TelemetryEvent): Promise<void> {
    console.log(JSON.stringify({ type: "telemetry_log", ...event }));
  }

  public async emitMetric(sample: MetricSample): Promise<void> {
    console.log(JSON.stringify({ type: "telemetry_metric", ...sample }));
  }

  public async emitAlert(event: AlertEvent): Promise<void> {
    console.error(JSON.stringify({ type: "telemetry_alert", ...event }));
  }
}
