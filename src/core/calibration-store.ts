import { openObservabilityDb } from "./sqlite";

export interface CalibrationSignalRow {
  runId: string;
  traceId: string;
  timestamp: string;
  agent: string;
  regime: string;
  expectedConfidence: number;
  outcomeScore: number;
}

export class SqliteCalibrationStore {
  private readonly db;

  public constructor(connectionString: string) {
    this.db = openObservabilityDb(connectionString);
  }

  public saveSignal(row: CalibrationSignalRow): void {
    this.db.prepare(`
      INSERT INTO calibration_signals (
        run_id, trace_id, timestamp, agent, regime, expected_confidence, outcome_score
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.runId,
      row.traceId,
      row.timestamp,
      row.agent,
      row.regime,
      row.expectedConfidence,
      row.outcomeScore,
    );
  }

  public getReliability(agent: string, regime?: string): number {
    const row = this.db.prepare(`
      SELECT AVG(outcome_score) AS score
      FROM calibration_signals
      WHERE agent = ?
        AND (? IS NULL OR regime = ?)
    `).get(agent, regime ?? null, regime ?? null) as { score?: number } | undefined;
    const score = row?.score;
    if (typeof score !== "number" || !Number.isFinite(score)) return 0.6;
    return Math.max(0.2, Math.min(0.95, Number(score)));
  }
}
