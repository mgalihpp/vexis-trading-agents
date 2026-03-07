import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const ensureDirectory = (dbPath: string): void => {
  const resolved = path.resolve(dbPath);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
};

const initSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS decision_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      input_json TEXT NOT NULL,
      output_json TEXT NOT NULL,
      rationale TEXT NOT NULL,
      source TEXT NOT NULL,
      retries INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_decision_logs_run ON decision_logs(run_id);
    CREATE INDEX IF NOT EXISTS idx_decision_logs_trace ON decision_logs(trace_id);
    CREATE INDEX IF NOT EXISTS idx_decision_logs_time ON decision_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_decision_logs_run_trace_time ON decision_logs(run_id, trace_id, timestamp);

    CREATE TABLE IF NOT EXISTS telemetry_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      data_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_telemetry_logs_trace ON telemetry_logs(trace_id);
    CREATE INDEX IF NOT EXISTS idx_telemetry_logs_time ON telemetry_logs(timestamp);

    CREATE TABLE IF NOT EXISTS telemetry_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      value REAL NOT NULL,
      timestamp TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      run_id TEXT,
      trace_id TEXT,
      mode TEXT,
      asset TEXT,
      node TEXT,
      provider TEXT,
      source TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_telemetry_metrics_name ON telemetry_metrics(name);
    CREATE INDEX IF NOT EXISTS idx_telemetry_metrics_name_latest ON telemetry_metrics(name, timestamp DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_telemetry_metrics_run ON telemetry_metrics(run_id);
    CREATE INDEX IF NOT EXISTS idx_telemetry_metrics_trace ON telemetry_metrics(trace_id);
    CREATE INDEX IF NOT EXISTS idx_telemetry_metrics_time ON telemetry_metrics(timestamp);
    CREATE INDEX IF NOT EXISTS idx_telemetry_metrics_run_trace_time ON telemetry_metrics(run_id, trace_id, timestamp);

    CREATE TABLE IF NOT EXISTS telemetry_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      name TEXT NOT NULL,
      severity TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      run_id TEXT,
      message TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      error_code TEXT,
      node TEXT,
      provider TEXT,
      last_successful_run TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_telemetry_alerts_time ON telemetry_alerts(timestamp);
    CREATE INDEX IF NOT EXISTS idx_telemetry_alerts_run ON telemetry_alerts(run_id);
    CREATE INDEX IF NOT EXISTS idx_telemetry_alerts_trace ON telemetry_alerts(trace_id);
    CREATE INDEX IF NOT EXISTS idx_telemetry_alerts_severity ON telemetry_alerts(severity);
    CREATE INDEX IF NOT EXISTS idx_telemetry_alerts_run_trace_time ON telemetry_alerts(run_id, trace_id, timestamp);

    CREATE TABLE IF NOT EXISTS protection_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL,
      symbol TEXT NOT NULL,
      parent_order_id TEXT NOT NULL,
      parent_side TEXT NOT NULL,
      parent_type TEXT NOT NULL,
      sl_price REAL,
      tp_price REAL,
      sl_order_id TEXT,
      tp_order_id TEXT,
      mode TEXT,
      status TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_error_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(scope, symbol, parent_order_id)
    );

    CREATE INDEX IF NOT EXISTS idx_protection_groups_status ON protection_groups(status);
    CREATE INDEX IF NOT EXISTS idx_protection_groups_scope_symbol ON protection_groups(scope, symbol);
  `);

  const columns = db.prepare("PRAGMA table_info(protection_groups)").all() as Array<{ name?: unknown }>;
  const names = new Set(columns.map((row) => String(row.name ?? "")));
  if (!names.has("retry_count")) {
    db.exec("ALTER TABLE protection_groups ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;");
  }
  if (!names.has("last_error_at")) {
    db.exec("ALTER TABLE protection_groups ADD COLUMN last_error_at TEXT;");
  }
};

export const openObservabilityDb = (dbPath: string): Database.Database => {
  ensureDirectory(dbPath);
  const db = new Database(path.resolve(dbPath));
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  initSchema(db);
  return db;
};
