import type { AlertEvent, MetricSample, TelemetryEvent, TelemetrySink } from "../types";
import { openObservabilityDb } from "./sqlite";

const serialize = (value: unknown): string => JSON.stringify(value ?? null);

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

export class FanoutTelemetrySink implements TelemetrySink {
  public constructor(private readonly sinks: TelemetrySink[]) {}

  public async emitLog(event: TelemetryEvent): Promise<void> {
    for (const sink of this.sinks) {
      await sink.emitLog(event);
    }
  }

  public async emitMetric(sample: MetricSample): Promise<void> {
    for (const sink of this.sinks) {
      await sink.emitMetric(sample);
    }
  }

  public async emitAlert(event: AlertEvent): Promise<void> {
    for (const sink of this.sinks) {
      await sink.emitAlert(event);
    }
  }
}

export interface RecentRunRecord {
  run_id: string;
  trace_id: string;
  mode: string;
  asset: string;
  last_timestamp: string;
  success: number;
}

export interface AlertQuery {
  sinceIso?: string;
  severity?: AlertEvent["severity"];
  runId?: string;
  traceId?: string;
  limit?: number;
}

export interface MetricQuery {
  sinceIso?: string;
  name?: string;
  runId?: string;
  traceId?: string;
  limit?: number;
}

export interface MetricRecord {
  name: string;
  value: number;
  timestamp: string;
  tags: Record<string, unknown>;
  run_id?: string;
  trace_id?: string;
  mode?: string;
  asset?: string;
  node?: string;
  provider?: string;
  source?: string;
}

export interface MetricSummaryRow {
  name: string;
  samples: number;
  min: number;
  max: number;
  avg: number;
  latest_timestamp: string;
  latest_value: number;
}

export interface PurgeResult {
  decisionLogsDeleted: number;
  telemetryLogsDeleted: number;
  telemetryMetricsDeleted: number;
  telemetryAlertsDeleted: number;
}

export class SqliteTelemetrySink implements TelemetrySink {
  private readonly db;

  public constructor(private readonly dbPath: string) {
    this.db = openObservabilityDb(dbPath);
  }

  public async emitLog(event: TelemetryEvent): Promise<void> {
    this.db.prepare(`
      INSERT INTO telemetry_logs (timestamp, level, message, trace_id, tags_json, data_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.timestamp,
      event.level,
      event.message,
      event.trace_id,
      serialize(event.tags),
      event.data ? serialize(event.data) : null
    );
  }

  public async emitMetric(sample: MetricSample): Promise<void> {
    const runId = typeof sample.tags.run_id === "string" ? sample.tags.run_id : null;
    const traceId = typeof sample.tags.trace_id === "string" ? sample.tags.trace_id : null;
    const mode = typeof sample.tags.mode === "string" ? sample.tags.mode : null;
    const asset = typeof sample.tags.asset === "string" ? sample.tags.asset : null;
    const node = typeof sample.tags.node === "string" ? sample.tags.node : null;
    const provider = typeof sample.tags.provider === "string" ? sample.tags.provider : null;
    const source = typeof sample.tags.source === "string" ? sample.tags.source : null;

    this.db.prepare(`
      INSERT INTO telemetry_metrics (
        name,
        value,
        timestamp,
        tags_json,
        run_id,
        trace_id,
        mode,
        asset,
        node,
        provider,
        source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sample.name,
      sample.value,
      sample.timestamp,
      serialize(sample.tags),
      runId,
      traceId,
      mode,
      asset,
      node,
      provider,
      source
    );
  }

  public async emitAlert(event: AlertEvent): Promise<void> {
    const runId = typeof event.tags.run_id === "string" ? event.tags.run_id : null;
    this.db.prepare(`
      INSERT INTO telemetry_alerts (
        timestamp,
        name,
        severity,
        trace_id,
        run_id,
        message,
        tags_json,
        error_code,
        node,
        provider,
        last_successful_run
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.timestamp,
      event.name,
      event.severity,
      event.trace_id,
      runId,
      event.message,
      serialize(event.tags),
      event.error_code ?? null,
      event.node ?? null,
      event.provider ?? null,
      event.last_successful_run ?? null
    );
  }

  public getRecentRuns(limit: number): RecentRunRecord[] {
    return this.db.prepare(`
      SELECT
        run_id,
        trace_id,
        mode,
        asset,
        MAX(timestamp) AS last_timestamp,
        MAX(CASE WHEN name = 'run_success' THEN value ELSE 0 END) AS success
      FROM telemetry_metrics
      WHERE run_id IS NOT NULL
      GROUP BY run_id, trace_id, mode, asset
      ORDER BY last_timestamp DESC
      LIMIT ?
    `).all(limit) as RecentRunRecord[];
  }

  public getAlerts(query: AlertQuery = {}): AlertEvent[] {
    const where: string[] = [];
    const params: unknown[] = [];

    if (query.sinceIso) {
      where.push("timestamp >= ?");
      params.push(query.sinceIso);
    }
    if (query.severity) {
      where.push("severity = ?");
      params.push(query.severity);
    }
    if (query.runId) {
      where.push("run_id = ?");
      params.push(query.runId);
    }
    if (query.traceId) {
      where.push("trace_id = ?");
      params.push(query.traceId);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const limitSql = query.limit && query.limit > 0 ? "LIMIT ?" : "";
    if (limitSql) {
      params.push(query.limit);
    }

    const rows = this.db.prepare(`
      SELECT timestamp, name, severity, trace_id, tags_json, message, error_code, node, provider, last_successful_run
      FROM telemetry_alerts
      ${whereSql}
      ORDER BY timestamp DESC, id DESC
      ${limitSql}
    `).all(...params);

    return (rows as Array<Record<string, unknown>>).map((row) => ({
      timestamp: String(row.timestamp),
      name: String(row.name),
      severity: row.severity as AlertEvent["severity"],
      trace_id: String(row.trace_id),
      tags: JSON.parse(String(row.tags_json)),
      message: String(row.message),
      error_code: row.error_code ? String(row.error_code) : undefined,
      node: row.node ? String(row.node) : undefined,
      provider: row.provider ? String(row.provider) : undefined,
      last_successful_run: row.last_successful_run ? String(row.last_successful_run) : undefined
    }));
  }

  public getMetrics(query: MetricQuery = {}): MetricRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.sinceIso) {
      where.push("timestamp >= ?");
      params.push(query.sinceIso);
    }
    if (query.name) {
      where.push("name = ?");
      params.push(query.name);
    }
    if (query.runId) {
      where.push("run_id = ?");
      params.push(query.runId);
    }
    if (query.traceId) {
      where.push("trace_id = ?");
      params.push(query.traceId);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const limitSql = query.limit && query.limit > 0 ? "LIMIT ?" : "";
    if (limitSql) {
      params.push(query.limit);
    }

    const rows = this.db.prepare(`
      SELECT name, value, timestamp, tags_json, run_id, trace_id, mode, asset, node, provider, source
      FROM telemetry_metrics
      ${whereSql}
      ORDER BY timestamp DESC, id DESC
      ${limitSql}
    `).all(...params) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      name: String(row.name),
      value: Number(row.value),
      timestamp: String(row.timestamp),
      tags: JSON.parse(String(row.tags_json)),
      run_id: row.run_id ? String(row.run_id) : undefined,
      trace_id: row.trace_id ? String(row.trace_id) : undefined,
      mode: row.mode ? String(row.mode) : undefined,
      asset: row.asset ? String(row.asset) : undefined,
      node: row.node ? String(row.node) : undefined,
      provider: row.provider ? String(row.provider) : undefined,
      source: row.source ? String(row.source) : undefined,
    }));
  }

  public getMetricSummary(limit = 200): MetricSummaryRow[] {
    const rows = this.db.prepare(`
      SELECT
        m.name AS name,
        COUNT(*) AS samples,
        MIN(m.value) AS min,
        MAX(m.value) AS max,
        AVG(m.value) AS avg,
        MAX(m.timestamp) AS latest_timestamp,
        (
          SELECT m2.value
          FROM telemetry_metrics m2
          WHERE m2.name = m.name
          ORDER BY m2.timestamp DESC, m2.id DESC
          LIMIT 1
        ) AS latest_value
      FROM telemetry_metrics m
      GROUP BY m.name
      ORDER BY latest_timestamp DESC
      LIMIT ?
    `).all(Math.max(1, limit)) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      name: String(row.name),
      samples: Number(row.samples),
      min: Number(row.min),
      max: Number(row.max),
      avg: Number(row.avg),
      latest_timestamp: String(row.latest_timestamp),
      latest_value: Number(row.latest_value),
    }));
  }

  public getRunTrace(identifier: { runId?: string; traceId?: string }): {
    decision_logs: Array<Record<string, unknown>>;
    metrics: Array<Record<string, unknown>>;
    alerts: AlertEvent[];
  } {
    const runId = identifier.runId ?? null;
    const traceId = identifier.traceId ?? null;
    const condition = runId ? "run_id = ?" : "trace_id = ?";
    const value = runId ?? traceId;

    if (!value) {
      return { decision_logs: [], metrics: [], alerts: [] };
    }

    const decisionLogs = this.db.prepare(`
      SELECT run_id, trace_id, agent, timestamp, input_json, output_json, rationale, source, retries
      FROM decision_logs
      WHERE ${condition}
      ORDER BY timestamp ASC, id ASC
    `).all(value) as Array<Record<string, unknown>>;

    const metrics = this.db.prepare(`
      SELECT name, value, timestamp, tags_json, run_id, trace_id, mode, asset, node, provider, source
      FROM telemetry_metrics
      WHERE ${condition}
      ORDER BY timestamp ASC, id ASC
    `).all(value) as Array<Record<string, unknown>>;

    const alerts = this.getAlerts({
      runId: runId ?? undefined,
      traceId: traceId ?? undefined
    });

    return {
      decision_logs: decisionLogs,
      metrics,
      alerts
    };
  }

  public purgeOlderThan(cutoffIso: string): PurgeResult {
    const tx = this.db.transaction((cutoff: string) => {
      const decisionLogsDeleted = this.db
        .prepare("DELETE FROM decision_logs WHERE timestamp < ?")
        .run(cutoff).changes;
      const telemetryLogsDeleted = this.db
        .prepare("DELETE FROM telemetry_logs WHERE timestamp < ?")
        .run(cutoff).changes;
      const telemetryMetricsDeleted = this.db
        .prepare("DELETE FROM telemetry_metrics WHERE timestamp < ?")
        .run(cutoff).changes;
      const telemetryAlertsDeleted = this.db
        .prepare("DELETE FROM telemetry_alerts WHERE timestamp < ?")
        .run(cutoff).changes;
      return {
        decisionLogsDeleted,
        telemetryLogsDeleted,
        telemetryMetricsDeleted,
        telemetryAlertsDeleted
      };
    });

    return tx(cutoffIso);
  }
}


