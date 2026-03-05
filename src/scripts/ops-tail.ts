import { loadRuntimeConfig } from "../core/env";
import { SqliteTelemetrySink, type RecentRunRecord } from "../core/telemetry";
import type { AlertEvent, AlertSeverity } from "../types";

interface TailFlags {
  runId?: string;
  traceId?: string;
  since?: string;
  severity?: AlertSeverity;
  limit: number;
  json: boolean;
}

const parseArgs = (argv: string[]): TailFlags => {
  const flags: TailFlags = {
    limit: 20,
    json: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    if (arg === "--run-id" && next) {
      flags.runId = next;
      i += 1;
      continue;
    }
    if (arg === "--trace-id" && next) {
      flags.traceId = next;
      i += 1;
      continue;
    }
    if (arg === "--since" && next) {
      flags.since = next;
      i += 1;
      continue;
    }
    if (arg === "--severity" && next) {
      if (["info", "warning", "critical"].includes(next)) {
        flags.severity = next as AlertSeverity;
      }
      i += 1;
      continue;
    }
    if (arg === "--limit" && next) {
      const parsed = Number.parseInt(next, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        flags.limit = parsed;
      }
      i += 1;
    }
  }

  return flags;
};

const formatCompact = (payload: {
  dbPath: string;
  recentRuns: RecentRunRecord[];
  alerts: AlertEvent[];
  trace: { decision_logs: Array<Record<string, unknown>>; metrics: Array<Record<string, unknown>>; alerts: AlertEvent[] };
}): string => {
  const lines: string[] = [];
  lines.push(`db: ${payload.dbPath}`);
  lines.push(`recent_runs: ${payload.recentRuns.length}`);
  for (const run of payload.recentRuns.slice(0, 5)) {
    lines.push(`- run=${String(run.run_id)} trace=${String(run.trace_id)} mode=${String(run.mode)} asset=${String(run.asset)} ok=${String(run.success)}`);
  }

  lines.push(`alerts: ${payload.alerts.length}`);
  for (const alert of payload.alerts.slice(0, 10)) {
    lines.push(`- [${String(alert.severity)}] ${String(alert.timestamp)} ${String(alert.name)} trace=${String(alert.trace_id)} msg=${String(alert.message)}`);
  }

  lines.push(`trace: decision_logs=${payload.trace.decision_logs.length} metrics=${payload.trace.metrics.length} alerts=${payload.trace.alerts.length}`);
  return lines.join("\n");
};

const main = async (): Promise<void> => {
  const runtime = loadRuntimeConfig();
  const flags = parseArgs(process.argv.slice(2));

  if (!runtime.obsPersistEnabled) {
    console.error("OBS_PERSIST_ENABLED is false. Enable it to use ops:tail.");
    process.exitCode = 1;
    return;
  }

  const sink = new SqliteTelemetrySink(runtime.obsSqlitePath);
  const sinceIso = flags.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const recentRuns = sink.getRecentRuns(flags.limit);
  const alerts = sink.getAlerts({
    sinceIso,
    severity: flags.severity,
    runId: flags.runId,
    traceId: flags.traceId,
    limit: flags.limit
  });

  const identifier = {
    runId: flags.runId ?? recentRuns[0]?.run_id,
    traceId: flags.traceId ?? recentRuns[0]?.trace_id
  };
  const trace = sink.getRunTrace(identifier);

  const payload = {
    db_path: runtime.obsSqlitePath,
    filters: flags,
    recent_runs: recentRuns,
    alerts,
    trace
  };

  if (flags.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(
    formatCompact({
      dbPath: runtime.obsSqlitePath,
      recentRuns,
      alerts,
      trace: {
        decision_logs: trace.decision_logs,
        metrics: trace.metrics,
        alerts: trace.alerts
      }
    })
  );
};

main().catch((error) => {
  console.error("ops:tail failed", error);
  process.exitCode = 1;
});
