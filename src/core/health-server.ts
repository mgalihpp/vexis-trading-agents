import http from "node:http";
import type { HealthMonitor, RunHealthSample } from "./health";
import type { HealthServerConfig, RunnerState } from "../types";
import type { AlertEvent } from "../types";
import type { MetricRecord, MetricSummaryRow } from "./telemetry";

export interface HealthServerDeps {
  config: HealthServerConfig;
  monitor: HealthMonitor;
  getRunnerState: () => RunnerState | null;
  getLastRun: () => RunHealthSample | null;
  getMetricsView?: (limit?: number) => {
    metrics: MetricRecord[];
    summary: MetricSummaryRow[];
    alerts: AlertEvent[];
  };
}

export class HealthServer {
  private server: http.Server | null = null;

  public constructor(private readonly deps: HealthServerDeps) {}

  public async start(): Promise<void> {
    if (!this.deps.config.enabled || this.server) {
      return;
    }

    this.server = http.createServer((req, res) => {
      const parsed = new URL(req.url ?? "/", `http://127.0.0.1:${this.deps.config.port}`);
      const path = parsed.pathname ?? "/";
      if (req.method !== "GET") {
        res.statusCode = 405;
        res.end("Method Not Allowed");
        return;
      }

      if (path === "/healthz") {
        this.sendJson(res, 200, {
          status: "ok",
          timestamp: new Date().toISOString()
        });
        return;
      }

      if (path === "/readyz") {
        const nowIso = () => new Date().toISOString();
        const statuses = this.deps.monitor.getSnapshot(nowIso);
        const degraded = statuses.some((s) => s.state !== "healthy");
        const runnerState = this.deps.getRunnerState();
        const lastRun = this.deps.getLastRun();

        this.sendJson(res, degraded ? 503 : 200, {
          status: degraded ? "degraded" : "ready",
          timestamp: nowIso(),
          runner: runnerState,
          last_run: lastRun,
          checks: statuses
        });
        return;
      }

      if (path === "/metricsz") {
        this.sendHtml(res, 200, this.metricsHtml());
        return;
      }

      if (path === "/metricsz/data") {
        if (!this.deps.getMetricsView) {
          this.sendJson(res, 503, {
            status: "metrics_unavailable",
            message: "Metrics view is not configured.",
          });
          return;
        }
        const limit = Number.parseInt(parsed.searchParams.get("limit") ?? "500", 10);
        const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 5000) : 500;
        const payload = this.deps.getMetricsView(safeLimit);
        this.sendJson(res, 200, {
          status: "ok",
          timestamp: new Date().toISOString(),
          total_metrics: payload.metrics.length,
          total_alerts: payload.alerts.length,
          summary: payload.summary,
          metrics: payload.metrics,
          alerts: payload.alerts,
        });
        return;
      }

      this.sendJson(res, 404, { status: "not_found", path });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.deps.config.port, () => resolve());
    });
  }

  public async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
    res.statusCode = statusCode;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(payload));
  }

  private sendHtml(res: http.ServerResponse, statusCode: number, html: string): void {
    res.statusCode = statusCode;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
  }

  private metricsHtml(): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Vexis Observability</title>
  <style>
    :root {
      --bg: #091225;
      --bg2: #0f1d36;
      --panel: #111f3a;
      --panel2: #152848;
      --text: #ecf4ff;
      --muted: #9db3d7;
      --accent: #4cc9f0;
      --accent2: #63e6be;
      --warn: #f59f00;
      --bad: #ff6b6b;
      --line: #254069;
      --chip: #132743;
      --shadow: 0 12px 30px rgba(3, 10, 25, 0.35);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text);
      font-family: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
      background:
        radial-gradient(1100px 520px at 85% -80px, rgba(76,201,240,0.22), transparent 60%),
        radial-gradient(850px 420px at -90px 20%, rgba(99,230,190,0.16), transparent 62%),
        linear-gradient(180deg, var(--bg2), var(--bg));
      min-height: 100vh;
    }
    .wrap {
      max-width: 1400px;
      margin: 26px auto 40px;
      padding: 0 18px;
    }
    .hero {
      border: 1px solid var(--line);
      background: linear-gradient(145deg, rgba(17,31,58,0.95), rgba(16,30,54,0.88));
      box-shadow: var(--shadow);
      border-radius: 16px;
      padding: 18px 18px 16px;
      margin-bottom: 16px;
    }
    .hero-top {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }
    h1 {
      margin: 0;
      font-size: 22px;
      letter-spacing: 0.2px;
      font-weight: 700;
    }
    .muted { color: var(--muted); }
    .controls {
      display: grid;
      grid-template-columns: 1fr 120px 120px auto auto;
      gap: 10px;
      align-items: center;
    }
    .controls .label {
      font-size: 12px;
      color: var(--muted);
      display: block;
      margin-bottom: 5px;
    }
    .field input, .field select, .btn {
      width: 100%;
      padding: 10px 11px;
      border-radius: 10px;
      border: 1px solid #335988;
      background: #0b1a33;
      color: var(--text);
      outline: none;
    }
    .field input:focus, .field select:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px rgba(76,201,240,0.2);
    }
    .btn {
      cursor: pointer;
      font-weight: 600;
      background: linear-gradient(180deg, #1f4f86, #193f6b);
    }
    .btn.secondary { background: linear-gradient(180deg, #24456f, #1b3557); }
    .cards {
      display: grid;
      grid-template-columns: repeat(4, minmax(150px, 1fr));
      gap: 10px;
      margin-top: 12px;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 12px;
      background: linear-gradient(150deg, rgba(21,40,72,0.95), rgba(16,31,56,0.92));
      padding: 10px 12px;
    }
    .card .title { font-size: 12px; color: var(--muted); }
    .card .value { font-size: 24px; font-weight: 700; margin-top: 2px; }
    .layout {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 14px;
      margin-top: 14px;
    }
    .panel {
      border: 1px solid var(--line);
      background: linear-gradient(150deg, rgba(17,31,58,0.94), rgba(14,27,50,0.92));
      box-shadow: var(--shadow);
      border-radius: 14px;
      padding: 12px;
    }
    .panel h2 {
      margin: 2px 0 10px;
      font-size: 15px;
      letter-spacing: 0.2px;
    }
    .table-wrap { max-height: 380px; overflow: auto; border-radius: 10px; border: 1px solid #1f355a; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td {
      text-align: left;
      border-bottom: 1px solid #20385f;
      padding: 7px 8px;
      white-space: nowrap;
    }
    th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: #122848;
      color: #bbd0f1;
      font-weight: 600;
      letter-spacing: 0.2px;
    }
    td.message { white-space: normal; min-width: 260px; max-width: 580px; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      border: 1px solid transparent;
      background: var(--chip);
    }
    .sev-critical { color: #ffd6d6; border-color: #7f3030; background: rgba(127,48,48,0.22); }
    .sev-warning { color: #ffe9c2; border-color: #7d5a1a; background: rgba(125,90,26,0.2); }
    .sev-info { color: #d5e9ff; border-color: #315f94; background: rgba(49,95,148,0.2); }
    .type-status { color: #dcfce7; border-color: #2f855a; background: rgba(47,133,90,0.2); }
    .type-gauge { color: #dbeafe; border-color: #3b82f6; background: rgba(59,130,246,0.2); }
    .metric-chip {
      max-width: 290px;
      overflow: hidden;
      text-overflow: ellipsis;
      display: inline-block;
      vertical-align: bottom;
    }
    .tiny {
      font-size: 11px;
      color: var(--muted);
      line-height: 1.4;
    }
    .mono { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }
    .empty {
      text-align: center;
      color: var(--muted);
      padding: 18px;
      border: 1px dashed #2c4d7a;
      border-radius: 10px;
      background: rgba(16,31,56,0.6);
    }
    @media (max-width: 1080px) {
      .layout { grid-template-columns: 1fr; }
      .controls { grid-template-columns: 1fr 1fr; }
      .controls .btn { width: 100%; }
      .cards { grid-template-columns: repeat(2, minmax(140px, 1fr)); }
    }
    @media (max-width: 640px) {
      .controls { grid-template-columns: 1fr; }
      .cards { grid-template-columns: 1fr; }
      .wrap { padding: 0 12px; }
      h1 { font-size: 19px; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      <div class="hero-top">
        <h1>Vexis Observability Dashboard</h1>
        <div id="stamp" class="tiny"></div>
      </div>

      <div class="controls">
        <div class="field">
          <span class="label">Metric Name Filter</span>
          <input id="metricFilter" placeholder="e.g. protection_, run_latency" />
        </div>
        <div class="field">
          <span class="label">Limit</span>
          <input id="limitInput" value="500" />
        </div>
        <div class="field">
          <span class="label">Refresh</span>
          <select id="refreshInput">
            <option value="3000">3s</option>
            <option value="5000" selected>5s</option>
            <option value="10000">10s</option>
            <option value="30000">30s</option>
          </select>
        </div>
        <button id="reloadBtn" class="btn">Reload</button>
        <button id="pauseBtn" class="btn secondary">Pause</button>
      </div>

      <div class="cards">
        <div class="card">
          <div class="title">Metric Samples</div>
          <div id="totalMetrics" class="value mono">0</div>
        </div>
        <div class="card">
          <div class="title">Alerts</div>
          <div id="totalAlerts" class="value mono">0</div>
        </div>
        <div class="card">
          <div class="title">Critical Alerts</div>
          <div id="totalCritical" class="value mono">0</div>
        </div>
        <div class="card">
          <div class="title">Metric Names</div>
          <div id="uniqueNames" class="value mono">0</div>
        </div>
      </div>
    </section>

    <div class="layout">
      <section class="panel">
        <h2>Metric Summary</h2>
        <div class="table-wrap">
          <table id="summaryTable">
            <thead><tr><th>name</th><th>type</th><th>samples</th><th>success rate</th><th>min</th><th>max</th><th>avg</th><th>latest</th><th>latest time</th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </section>

      <section class="panel">
        <h2>Top Fresh Metrics</h2>
        <div id="topMetrics" class="tiny"></div>
      </section>
    </div>

    <section class="panel">
      <h2>Recent Metric Samples</h2>
      <div class="table-wrap">
        <table id="metricsTable">
          <thead><tr><th>timestamp</th><th>name</th><th>value</th><th>run_id</th><th>trace_id</th><th>mode</th><th>asset</th><th>node</th><th>provider</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <h2>Recent Alerts</h2>
      <div class="table-wrap">
        <table id="alertsTable">
          <thead><tr><th>timestamp</th><th>severity</th><th>name</th><th>message</th><th>trace_id</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </section>
  </div>

  <script>
    const summaryBody = document.querySelector('#summaryTable tbody');
    const metricsBody = document.querySelector('#metricsTable tbody');
    const alertsBody = document.querySelector('#alertsTable tbody');
    const topMetrics = document.getElementById('topMetrics');
    const metricFilterInput = document.getElementById('metricFilter');
    const limitInput = document.getElementById('limitInput');
    const refreshInput = document.getElementById('refreshInput');
    const reloadBtn = document.getElementById('reloadBtn');
    const pauseBtn = document.getElementById('pauseBtn');
    const stamp = document.getElementById('stamp');
    let timer = null;
    let paused = false;

    const fmt = (n) => Number.isFinite(Number(n)) ? Number(n).toFixed(6) : String(n ?? '');
    const esc = (v) => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const sevClass = (s) => s === 'critical' ? 'sev-critical' : s === 'warning' ? 'sev-warning' : 'sev-info';
    const statusName = (name) => String(name ?? '').toLowerCase().includes('heartbeat') || String(name ?? '').toLowerCase().endsWith('_success');
    const fmtTime = (v) => {
      if (!v) return '';
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return String(v);
      return d.toLocaleString();
    };

    async function load() {
      const limit = parseInt(limitInput.value || '500', 10) || 500;
      const res = await fetch('/metricsz/data?limit=' + encodeURIComponent(limit));
      const data = await res.json();
      document.getElementById('totalMetrics').textContent = String(data.total_metrics ?? 0);
      document.getElementById('totalAlerts').textContent = String(data.total_alerts ?? 0);
      const criticalAlerts = (data.alerts || []).filter(a => a.severity === 'critical').length;
      document.getElementById('totalCritical').textContent = String(criticalAlerts);
      document.getElementById('uniqueNames').textContent = String((data.summary || []).length);
      stamp.textContent = 'Last update: ' + new Date(data.timestamp || Date.now()).toLocaleString();

      const filter = (metricFilterInput.value || '').toLowerCase();
      const summaryRows = (data.summary || []).filter(r => !filter || String(r.name || '').toLowerCase().includes(filter));
      const metricRows = (data.metrics || []).filter(r => !filter || String(r.name || '').toLowerCase().includes(filter));
      const grouped = new Map();
      for (const r of metricRows) {
        const name = String(r.name ?? '');
        const value = Number(r.value);
        const row = grouped.get(name) || { total: 0, success: 0, binaryCount: 0, isStatusByName: statusName(name) };
        row.total += 1;
        if (Number.isFinite(value)) {
          if (value === 1 || value === 0) {
            row.binaryCount += 1;
            if (value === 1) row.success += 1;
          }
        }
        grouped.set(name, row);
      }

      function metricType(name) {
        const g = grouped.get(String(name ?? ''));
        if (!g) return statusName(name) ? 'status' : 'gauge';
        const mostlyBinary = g.total > 0 && (g.binaryCount / g.total) >= 0.8;
        return g.isStatusByName || mostlyBinary ? 'status' : 'gauge';
      }

      function successRate(name) {
        const g = grouped.get(String(name ?? ''));
        if (!g || g.total === 0 || metricType(name) !== 'status') return '-';
        if (g.binaryCount === 0) return '-';
        return ((g.success / g.binaryCount) * 100).toFixed(1) + '%';
      }

      if (summaryRows.length === 0) {
        summaryBody.innerHTML = '<tr><td colspan="9"><div class="empty">No metrics match this filter.</div></td></tr>';
      } else {
      summaryBody.innerHTML = summaryRows.map(r => '<tr>' +
        '<td><span class="badge"><span class="metric-chip mono">' + esc(r.name ?? '') + '</span></span></td>' +
        '<td><span class="badge ' + (metricType(r.name) === 'status' ? 'type-status' : 'type-gauge') + '">' + metricType(r.name) + '</span></td>' +
        '<td>' + (r.samples ?? '') + '</td>' +
        '<td>' + successRate(r.name) + '</td>' +
        '<td>' + fmt(r.min) + '</td>' +
        '<td>' + fmt(r.max) + '</td>' +
        '<td>' + fmt(r.avg) + '</td>' +
        '<td>' + fmt(r.latest_value) + '</td>' +
        '<td class="mono">' + esc(fmtTime(r.latest_timestamp)) + '</td>' +
      '</tr>').join('');
      }

      if (metricRows.length === 0) {
        metricsBody.innerHTML = '<tr><td colspan="9"><div class="empty">No metric samples available.</div></td></tr>';
      } else {
      metricsBody.innerHTML = metricRows.map(r => '<tr>' +
        '<td class="mono">' + esc(fmtTime(r.timestamp)) + '</td>' +
        '<td><span class="badge"><span class="metric-chip mono">' + esc(r.name ?? '') + '</span></span></td>' +
        '<td>' + fmt(r.value) + '</td>' +
        '<td class="mono">' + esc(r.run_id ?? '') + '</td>' +
        '<td class="mono">' + esc(r.trace_id ?? '') + '</td>' +
        '<td>' + esc(r.mode ?? '') + '</td>' +
        '<td>' + esc(r.asset ?? '') + '</td>' +
        '<td>' + esc(r.node ?? '') + '</td>' +
        '<td>' + esc(r.provider ?? '') + '</td>' +
      '</tr>').join('');
      }

      const alerts = data.alerts || [];
      if (alerts.length === 0) {
        alertsBody.innerHTML = '<tr><td colspan="5"><div class="empty">No alerts yet.</div></td></tr>';
      } else {
        alertsBody.innerHTML = alerts.map(a => '<tr>' +
        '<td class="mono">' + esc(fmtTime(a.timestamp)) + '</td>' +
        '<td><span class="badge ' + sevClass(a.severity) + '">' + esc(a.severity ?? '') + '</span></td>' +
        '<td>' + esc(a.name ?? '') + '</td>' +
        '<td class="message">' + esc(a.message ?? '') + '</td>' +
        '<td class="mono">' + esc(a.trace_id ?? '') + '</td>' +
      '</tr>').join('');
      }

      const top = summaryRows.slice(0, 6);
      if (top.length === 0) {
        topMetrics.innerHTML = '<div class="empty">No summary data.</div>';
      } else {
        topMetrics.innerHTML = top.map(r =>
          '<div class="badge" style="margin:0 8px 8px 0;">' +
            '<span class="mono">' + esc(r.name) + '</span>' +
            '<span class="muted">latest:</span>' +
            '<strong>' + fmt(r.latest_value) + '</strong>' +
          '</div>'
        ).join('');
      }
    }

    function startTimer() {
      if (timer) clearInterval(timer);
      const ms = parseInt(refreshInput.value || '5000', 10) || 5000;
      timer = setInterval(() => {
        if (!paused) load();
      }, ms);
    }

    reloadBtn.addEventListener('click', load);
    metricFilterInput.addEventListener('input', load);
    refreshInput.addEventListener('change', startTimer);
    pauseBtn.addEventListener('click', () => {
      paused = !paused;
      pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    });
    startTimer();
    load();
  </script>
</body>
</html>`;
  }
}
