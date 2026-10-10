import { Hono, type Context } from "hono";
import { AggregatorUnavailableError, InvalidPayloadError, type TrackingAggregator } from "./aggregator/types.ts";
import type { Clock } from "./clock.ts";
import type { AlertRow, Db, ShipmentRow } from "./db.ts";
import { NotFoundError, TrackingService, type TrackingConfig } from "./service.ts";

export interface AppDeps {
  db: Db;
  clock: Clock;
  aggregator: TrackingAggregator;
  config: TrackingConfig;
}

type ErrorStatus = 400 | 404 | 502;

function fail(c: Context, status: ErrorStatus, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

const TRACKING_CODE = /^[A-Za-z0-9-]{4,40}$/;
const CARRIER = /^[a-z0-9_-]{2,30}$/;

function alertView(row: AlertRow) {
  return { id: row.id, shipment_id: row.shipment_id, kind: row.kind, details: JSON.parse(row.details), created_at: row.created_at };
}

export function createApp(deps: AppDeps) {
  const { db } = deps;
  const service = new TrackingService(deps.db, deps.clock, deps.aggregator, deps.config);
  const app = new Hono();

  const shipmentView = (row: ShipmentRow) => ({
    id: row.id,
    carrier: row.carrier,
    tracking_code: row.tracking_code,
    aggregator_ref: row.aggregator_ref,
    status: row.status,
    status_since: row.status_since,
    transit_started_at: row.transit_started_at,
    delivered_at: row.delivered_at,
    delayed: service.isDelayed(row),
    needs_review: row.needs_review === 1,
    events: db.listEvents(row.id).map((e) => ({
      status: e.status,
      raw_code: e.raw_code,
      description: e.description,
      location: e.location,
      occurred_at: e.occurred_at,
    })),
    status_changes: db.listStatusChanges(row.id).map((s) => ({ from: s.from_status, to: s.to_status, at: s.changed_at })),
    alerts: db.listAlerts(row.id).map(alertView),
  });

  app.onError((error, c) => {
    if (error instanceof NotFoundError) return fail(c, 404, "nao_encontrado", error.message);
    if (error instanceof InvalidPayloadError) return fail(c, 400, "payload_invalido", error.message);
    if (error instanceof AggregatorUnavailableError) return fail(c, 502, "agregador_indisponivel", error.message);
    console.error(error);
    return c.json({ error: { code: "erro_interno", message: "erro inesperado" } }, 500);
  });

  app.notFound((c) => fail(c, 404, "rota_inexistente", `rota ${c.req.method} ${c.req.path} não existe`));

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/shipments", async (c) => {
    const body = await c.req.json().catch(() => null);
    const trackingCode = typeof body?.tracking_code === "string" ? body.tracking_code.trim().toUpperCase() : "";
    const carrier = typeof body?.carrier === "string" ? body.carrier.trim().toLowerCase() : "";
    if (!TRACKING_CODE.test(trackingCode)) {
      return fail(c, 400, "validacao", "tracking_code é obrigatório (4 a 40 letras, números ou hífen)");
    }
    if (!CARRIER.test(carrier)) {
      return fail(c, 400, "validacao", "carrier é obrigatório (ex.: correios, jadlog, loggi)");
    }
    const { shipment, created } = await service.register({ carrier, trackingCode });
    return c.json(shipmentView(shipment), created ? 201 : 200);
  });

  app.get("/shipments", (c) => c.json({ shipments: db.listShipments().map(shipmentView) }));

  app.get("/shipments/:id", (c) => {
    const shipment = db.findShipment(c.req.param("id"));
    if (!shipment) return fail(c, 404, "nao_encontrado", `remessa ${c.req.param("id")} não encontrada`);
    return c.json(shipmentView(shipment));
  });

  app.post("/shipments/:id/refresh", async (c) => {
    const { shipment, newEvents } = await service.refresh(c.req.param("id"));
    return c.json({ new_events: newEvents, shipment: shipmentView(shipment) });
  });

  app.post("/webhooks/aggregator", async (c) => {
    const body = await c.req.json().catch(() => {
      throw new InvalidPayloadError("corpo não é JSON válido");
    });
    const { shipment, newEvents } = service.ingestWebhook(body);
    return c.json({ new_events: newEvents, shipment_id: shipment.id, status: shipment.status });
  });

  app.post("/jobs/check-delays", (c) => {
    const result = service.checkDelays();
    return c.json({ checked: result.checked, delayed: result.delayed, alerts_created: result.alertsCreated });
  });

  app.get("/alerts", (c) => c.json({ alerts: db.listAlerts().map(alertView) }));

  return app;
}
