import { openObservabilityDb } from "./sqlite";

export type ProtectionScope = "spot" | "usdm" | "coinm";
export type ProtectionStatus = "pending_parent" | "active" | "closed" | "error";
export type ProtectionModeRecord = "native" | "fallback";

export interface ProtectionGroupRecord {
  id: number;
  scope: ProtectionScope;
  symbol: string;
  parentOrderId: string;
  parentSide: "buy" | "sell";
  parentType: "market" | "limit";
  slPrice?: number;
  tpPrice?: number;
  slOrderId?: string;
  tpOrderId?: string;
  mode?: ProtectionModeRecord;
  status: ProtectionStatus;
  retryCount: number;
  lastError?: string;
  lastErrorAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProtectionGroupCreateInput {
  scope: ProtectionScope;
  symbol: string;
  parentOrderId: string;
  parentSide: "buy" | "sell";
  parentType: "market" | "limit";
  slPrice?: number;
  tpPrice?: number;
}

const asNum = (value: unknown): number | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

const asRecord = (row: Record<string, unknown>): ProtectionGroupRecord => ({
  id: Number(row.id),
  scope: String(row.scope) as ProtectionScope,
  symbol: String(row.symbol),
  parentOrderId: String(row.parent_order_id),
  parentSide: String(row.parent_side) === "sell" ? "sell" : "buy",
  parentType: String(row.parent_type) === "limit" ? "limit" : "market",
  slPrice: asNum(row.sl_price),
  tpPrice: asNum(row.tp_price),
  slOrderId: row.sl_order_id ? String(row.sl_order_id) : undefined,
  tpOrderId: row.tp_order_id ? String(row.tp_order_id) : undefined,
  mode: row.mode ? (String(row.mode) as ProtectionModeRecord) : undefined,
  status: String(row.status) as ProtectionStatus,
  retryCount: Number(row.retry_count ?? 0),
  lastError: row.last_error ? String(row.last_error) : undefined,
  lastErrorAt: row.last_error_at ? String(row.last_error_at) : undefined,
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

export class ProtectionGroupStore {
  private readonly db;

  public constructor(dbPath: string) {
    this.db = openObservabilityDb(dbPath);
  }

  public upsertPending(input: ProtectionGroupCreateInput): ProtectionGroupRecord {
    const nowIso = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO protection_groups (
        scope, symbol, parent_order_id, parent_side, parent_type, sl_price, tp_price, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_parent', ?, ?)
      ON CONFLICT(scope, symbol, parent_order_id) DO UPDATE SET
        parent_side = excluded.parent_side,
        parent_type = excluded.parent_type,
        sl_price = excluded.sl_price,
        tp_price = excluded.tp_price,
        status = excluded.status,
        retry_count = 0,
        updated_at = excluded.updated_at,
        last_error = NULL,
        last_error_at = NULL
    `).run(
      input.scope,
      input.symbol,
      input.parentOrderId,
      input.parentSide,
      input.parentType,
      input.slPrice ?? null,
      input.tpPrice ?? null,
      nowIso,
      nowIso
    );
    return this.findByParent(input.scope, input.symbol, input.parentOrderId)!;
  }

  public findByParent(scope: ProtectionScope, symbol: string, parentOrderId: string): ProtectionGroupRecord | null {
    const row = this.db
      .prepare(`
        SELECT *
        FROM protection_groups
        WHERE scope = ? AND symbol = ? AND parent_order_id = ?
        LIMIT 1
      `)
      .get(scope, symbol, parentOrderId) as Record<string, unknown> | undefined;
    return row ? asRecord(row) : null;
  }

  public listByStatuses(statuses: ProtectionStatus[], limit = 200): ProtectionGroupRecord[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`
        SELECT *
        FROM protection_groups
        WHERE status IN (${placeholders})
        ORDER BY updated_at ASC, id ASC
        LIMIT ?
      `)
      .all(...statuses, Math.max(1, limit)) as Array<Record<string, unknown>>;
    return rows.map(asRecord);
  }

  public markActive(
    id: number,
    input: { mode: ProtectionModeRecord; slOrderId?: string; tpOrderId?: string }
  ): void {
    const nowIso = new Date().toISOString();
    this.db.prepare(`
      UPDATE protection_groups
      SET status = 'active',
          mode = ?,
          sl_order_id = ?,
          tp_order_id = ?,
          retry_count = 0,
          last_error = NULL,
          last_error_at = NULL,
          updated_at = ?
      WHERE id = ?
    `).run(input.mode, input.slOrderId ?? null, input.tpOrderId ?? null, nowIso, id);
  }

  public markClosed(id: number): void {
    const nowIso = new Date().toISOString();
    this.db.prepare(`
      UPDATE protection_groups
      SET status = 'closed',
          updated_at = ?
      WHERE id = ?
    `).run(nowIso, id);
  }

  public markError(id: number, message: string): void {
    const nowIso = new Date().toISOString();
    this.db.prepare(`
      UPDATE protection_groups
      SET status = 'error',
          retry_count = COALESCE(retry_count, 0) + 1,
          last_error = ?,
          last_error_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(message, nowIso, nowIso, id);
  }

  public recordMonitorError(id: number, message: string): number {
    const nowIso = new Date().toISOString();
    this.db.prepare(`
      UPDATE protection_groups
      SET retry_count = COALESCE(retry_count, 0) + 1,
          last_error = ?,
          last_error_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(message, nowIso, nowIso, id);

    const row = this.db
      .prepare("SELECT retry_count FROM protection_groups WHERE id = ? LIMIT 1")
      .get(id) as { retry_count?: unknown } | undefined;
    return Number(row?.retry_count ?? 0);
  }
}
