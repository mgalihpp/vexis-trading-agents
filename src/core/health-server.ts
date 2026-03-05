import http from "node:http";
import type { HealthMonitor, RunHealthSample } from "./health";
import type { HealthServerConfig, RunnerState } from "../types";

export interface HealthServerDeps {
  config: HealthServerConfig;
  monitor: HealthMonitor;
  getRunnerState: () => RunnerState | null;
  getLastRun: () => RunHealthSample | null;
}

export class HealthServer {
  private server: http.Server | null = null;

  public constructor(private readonly deps: HealthServerDeps) {}

  public async start(): Promise<void> {
    if (!this.deps.config.enabled || this.server) {
      return;
    }

    this.server = http.createServer((req, res) => {
      const path = req.url?.split("?")[0] ?? "/";
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
}
