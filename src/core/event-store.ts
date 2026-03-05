import type { DecisionLogEntry, EventStore, EventStorePersistence } from "../types";
import { openObservabilityDb } from "./sqlite";

const serialize = (value: unknown): string => JSON.stringify(value ?? null);

export class InMemoryEventStore implements EventStore {
  private readonly events: DecisionLogEntry[] = [];

  public constructor(private readonly persistence?: EventStorePersistence) {}

  public async append(event: DecisionLogEntry): Promise<void> {
    this.events.push(event);
    if (this.persistence) {
      await this.persistence.save(this.events);
    }
  }

  public getAll(): DecisionLogEntry[] {
    return [...this.events];
  }

  public clear(): void {
    this.events.length = 0;
  }
}

export class SqliteEventStorePersistence implements EventStorePersistence {
  private readonly db;
  private readonly lastSavedCounts = new Map<string, number>();

  public constructor(private readonly connectionString: string) {
    this.db = openObservabilityDb(connectionString);
  }

  public async save(events: DecisionLogEntry[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    const runId = events[0]?.runId;
    if (!runId) {
      return;
    }

    const alreadySaved = this.lastSavedCounts.get(runId) ?? 0;
    if (alreadySaved >= events.length) {
      return;
    }

    const pending = events.slice(alreadySaved);
    const insert = this.db.prepare(`
      INSERT INTO decision_logs (
        run_id,
        trace_id,
        agent,
        timestamp,
        input_json,
        output_json,
        rationale,
        source,
        retries
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = this.db.transaction((rows: DecisionLogEntry[]) => {
      for (const row of rows) {
        insert.run(
          row.runId,
          row.traceId,
          row.agent,
          row.timestamp,
          serialize(row.inputPayload),
          serialize(row.outputPayload),
          row.decisionRationale,
          row.source,
          row.retries
        );
      }
    });

    tx(pending);
    this.lastSavedCounts.set(runId, events.length);
  }

  public async load(): Promise<DecisionLogEntry[]> {
    const rows = this.db.prepare(`
      SELECT run_id, trace_id, agent, timestamp, input_json, output_json, rationale, source, retries
      FROM decision_logs
      ORDER BY timestamp ASC, id ASC
    `).all() as Array<{
      run_id: string;
      trace_id: string;
      agent: string;
      timestamp: string;
      input_json: string;
      output_json: string;
      rationale: string;
      source: DecisionLogEntry["source"];
      retries: number;
    }>;

    return rows.map((row) => ({
      runId: row.run_id,
      traceId: row.trace_id,
      agent: row.agent,
      timestamp: row.timestamp,
      inputPayload: JSON.parse(row.input_json),
      outputPayload: JSON.parse(row.output_json),
      decisionRationale: row.rationale,
      source: row.source,
      retries: row.retries
    }));
  }
}


