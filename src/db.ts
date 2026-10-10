import { DatabaseSync } from "node:sqlite";
import type { EventStatus, IgnoredReason, ShipmentStatus, StoredEvent } from "./domain/status.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shipments (
  id                 TEXT PRIMARY KEY,
  carrier            TEXT NOT NULL,
  tracking_code      TEXT NOT NULL,
  aggregator_ref     TEXT NOT NULL UNIQUE,
  status             TEXT,
  status_since       TEXT,
  transit_started_at TEXT,
  delivered_at       TEXT,
  needs_review       INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (carrier, tracking_code)
);

-- A UNIQUE (shipment_id, event_key) é o que impede histórico duplicado.
CREATE INDEX IF NOT EXISTS idx_shipments_created ON shipments (created_at, id);
CREATE INDEX IF NOT EXISTS idx_shipments_in_transit ON shipments (transit_started_at)
  WHERE transit_started_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS tracking_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id TEXT NOT NULL REFERENCES shipments(id),
  event_key   TEXT NOT NULL,
  status      TEXT NOT NULL,
  raw_code    TEXT NOT NULL,
  description TEXT,
  location    TEXT,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  -- Preenchido quando o evento fica no histórico mas fora do cálculo (ex.: data_no_futuro).
  ignored_reason TEXT,
  UNIQUE (shipment_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_events_shipment ON tracking_events (shipment_id, occurred_at);

CREATE TABLE IF NOT EXISTS status_changes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id TEXT NOT NULL REFERENCES shipments(id),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  changed_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_status_changes_shipment ON status_changes (shipment_id, id);

-- Um alerta por remessa e tipo. Funciona também como outbox para quem for notificar.
CREATE TABLE IF NOT EXISTS alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id TEXT NOT NULL REFERENCES shipments(id),
  kind        TEXT NOT NULL,
  details     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  -- 1 quando o job não conseguiu reconsultar o agregador antes de criar o alerta.
  stale       INTEGER NOT NULL DEFAULT 0,
  -- Preenchido quando a remessa é entregue depois do alerta.
  resolved_at TEXT,
  UNIQUE (shipment_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_alerts_open ON alerts (id) WHERE resolved_at IS NULL;
`;

export interface ShipmentRow {
  id: string;
  carrier: string;
  tracking_code: string;
  aggregator_ref: string;
  status: ShipmentStatus | null;
  status_since: string | null;
  transit_started_at: string | null;
  delivered_at: string | null;
  needs_review: number;
  created_at: string;
  updated_at: string;
}

export interface EventRow {
  id: number;
  shipment_id: string;
  event_key: string;
  status: EventStatus;
  raw_code: string;
  description: string | null;
  location: string | null;
  occurred_at: string;
  received_at: string;
  ignored_reason: IgnoredReason | null;
}

export interface StatusChangeRow {
  id: number;
  shipment_id: string;
  from_status: ShipmentStatus | null;
  to_status: ShipmentStatus;
  changed_at: string;
}

export interface AlertRow {
  id: number;
  shipment_id: string;
  kind: string;
  details: string;
  created_at: string;
  stale: number;
  resolved_at: string | null;
}

export interface ShipmentStateUpdate {
  status: ShipmentStatus | null;
  statusSince: string | null;
  transitStartedAt: string | null;
  deliveredAt: string | null;
  needsReview: boolean;
  updatedAt: string;
}

export class Db {
  readonly raw: DatabaseSync;

  constructor(path = ":memory:") {
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.raw.exec(SCHEMA);
  }

  /** BEGIN IMMEDIATE pega o lock de escrita logo no início, então ler-derivar-gravar é atômico. */
  transaction<T>(fn: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }

  /** Devolve true se inseriu, false se o código já estava cadastrado. */
  insertShipment(row: Pick<ShipmentRow, "id" | "carrier" | "tracking_code" | "aggregator_ref" | "created_at">): boolean {
    const result = this.raw
      .prepare(
        `INSERT INTO shipments (id, carrier, tracking_code, aggregator_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(row.id, row.carrier, row.tracking_code, row.aggregator_ref, row.created_at, row.created_at);
    return result.changes > 0;
  }

  findShipment(id: string): ShipmentRow | undefined {
    return this.raw.prepare("SELECT * FROM shipments WHERE id = ?").get(id) as ShipmentRow | undefined;
  }

  findShipmentByCode(carrier: string, trackingCode: string): ShipmentRow | undefined {
    return this.raw
      .prepare("SELECT * FROM shipments WHERE carrier = ? AND tracking_code = ?")
      .get(carrier, trackingCode) as ShipmentRow | undefined;
  }

  findShipmentByRef(ref: string): ShipmentRow | undefined {
    return this.raw.prepare("SELECT * FROM shipments WHERE aggregator_ref = ?").get(ref) as ShipmentRow | undefined;
  }

  listShipments(limit: number, offset: number): ShipmentRow[] {
    return this.raw
      .prepare("SELECT * FROM shipments ORDER BY created_at, id LIMIT ? OFFSET ?")
      .all(limit, offset) as unknown as ShipmentRow[];
  }

  /** Remessas em que o relógio de trânsito está correndo (candidatas a atraso). */
  listShipmentsInTransit(): ShipmentRow[] {
    return this.raw
      .prepare(
        `SELECT * FROM shipments
         WHERE transit_started_at IS NOT NULL AND (status IS NULL OR status <> 'entregue')
         ORDER BY transit_started_at`,
      )
      .all() as unknown as ShipmentRow[];
  }

  /** Insere só os eventos ainda não vistos. Devolve quantos eram novos. */
  insertEvents(shipmentId: string, events: readonly StoredEvent[], receivedAt: string): number {
    const stmt = this.raw.prepare(
      `INSERT INTO tracking_events
         (shipment_id, event_key, status, raw_code, description, location, occurred_at, received_at, ignored_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (shipment_id, event_key) DO NOTHING`,
    );
    let inserted = 0;
    for (const e of events) {
      const result = stmt.run(
        shipmentId,
        e.key,
        e.status,
        e.rawCode,
        e.description,
        e.location,
        e.occurredAt.toISOString(),
        receivedAt,
        e.ignoredReason,
      );
      inserted += Number(result.changes);
    }
    return inserted;
  }

  updateEventStatus(id: number, status: EventStatus): void {
    this.raw.prepare("UPDATE tracking_events SET status = ? WHERE id = ?").run(status, id);
  }

  listEvents(shipmentId: string): EventRow[] {
    return this.raw
      .prepare("SELECT * FROM tracking_events WHERE shipment_id = ? ORDER BY occurred_at, id")
      .all(shipmentId) as unknown as EventRow[];
  }

  updateShipmentState(id: string, state: ShipmentStateUpdate): void {
    this.raw
      .prepare(
        `UPDATE shipments
         SET status = ?, status_since = ?, transit_started_at = ?, delivered_at = ?, needs_review = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        state.status,
        state.statusSince,
        state.transitStartedAt,
        state.deliveredAt,
        state.needsReview ? 1 : 0,
        state.updatedAt,
        id,
      );
  }

  insertStatusChange(shipmentId: string, from: ShipmentStatus | null, to: ShipmentStatus, changedAt: string): void {
    this.raw
      .prepare("INSERT INTO status_changes (shipment_id, from_status, to_status, changed_at) VALUES (?, ?, ?, ?)")
      .run(shipmentId, from, to, changedAt);
  }

  listStatusChanges(shipmentId: string): StatusChangeRow[] {
    return this.raw
      .prepare("SELECT * FROM status_changes WHERE shipment_id = ? ORDER BY id")
      .all(shipmentId) as unknown as StatusChangeRow[];
  }

  /** Devolve true só para quem criou o alerta. Rodar o job de novo não duplica. */
  insertAlert(shipmentId: string, kind: string, details: unknown, createdAt: string, stale = false): boolean {
    const result = this.raw
      .prepare(
        `INSERT INTO alerts (shipment_id, kind, details, created_at, stale) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (shipment_id, kind) DO NOTHING`,
      )
      .run(shipmentId, kind, JSON.stringify(details), createdAt, stale ? 1 : 0);
    return result.changes > 0;
  }

  hasAlert(shipmentId: string, kind: string): boolean {
    return this.raw.prepare("SELECT 1 FROM alerts WHERE shipment_id = ? AND kind = ?").get(shipmentId, kind) !== undefined;
  }

  listAlerts(shipmentId: string): AlertRow[] {
    return this.raw
      .prepare("SELECT * FROM alerts WHERE shipment_id = ? ORDER BY id")
      .all(shipmentId) as unknown as AlertRow[];
  }

  listAlertsPage(limit: number, offset: number, includeResolved: boolean): AlertRow[] {
    const where = includeResolved ? "" : "WHERE resolved_at IS NULL";
    return this.raw
      .prepare(`SELECT * FROM alerts ${where} ORDER BY id LIMIT ? OFFSET ?`)
      .all(limit, offset) as unknown as AlertRow[];
  }

  resolveAlerts(shipmentId: string, resolvedAt: string): void {
    this.raw
      .prepare("UPDATE alerts SET resolved_at = ? WHERE shipment_id = ? AND resolved_at IS NULL")
      .run(resolvedAt, shipmentId);
  }
}
