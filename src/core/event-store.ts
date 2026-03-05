import type { DecisionLogEntry, EventStore, EventStorePersistence } from "../types";

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

export class SQLiteEventStorePersistenceStub implements EventStorePersistence {
  public constructor(private readonly connectionString: string) {
    void this.connectionString;
  }

  public async save(_events: DecisionLogEntry[]): Promise<void> {
    throw new Error("SQLiteEventStorePersistenceStub.save is not implemented.");
  }

  public async load(): Promise<DecisionLogEntry[]> {
    throw new Error("SQLiteEventStorePersistenceStub.load is not implemented.");
  }
}
