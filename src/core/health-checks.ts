import type { HealthCheck, HealthStatus } from "../types";
import type { HealthMonitor } from "./health";

export class MonitorBackedHealthCheck implements HealthCheck {
  public constructor(
    private readonly monitor: HealthMonitor,
    private readonly target: string,
    private readonly nowIso: () => string
  ) {}

  public async run(): Promise<HealthStatus> {
    const statuses = this.monitor.getSnapshot(this.nowIso);
    return (
      statuses.find((status) => status.target === this.target) ?? {
        target: this.target,
        kind: "system",
        state: "degraded",
        timestamp: this.nowIso(),
        message: `No health sample for ${this.target}`,
        tags: {}
      }
    );
  }
}
