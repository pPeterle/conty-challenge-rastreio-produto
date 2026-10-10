import { zValidator } from "@hono/zod-validator";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { ZodError } from "zod";
import {
  AggregatorResponseError,
  AggregatorUnavailableError,
  InvalidPayloadError,
  InvalidSignatureError,
  type TrackingAggregator,
} from "./aggregator/types.ts";
import type { Clock } from "./clock.ts";
import type { AlertRow, Db, ShipmentRow } from "./db.ts";
import { silentLogger, type Logger } from "./logger.ts";
import { alertsQuery, createShipmentBody, pageQuery, shipmentIdParam } from "./schemas.ts";
import { NotFoundError, TrackingService, type TrackingConfig } from "./service.ts";
import { issuesOf, summarize, type FieldIssue } from "./validation.ts";

export interface AppDeps {
  db: Db;
  clock: Clock;
  aggregator: TrackingAggregator;
  config: TrackingConfig;
  /** Padrão: logger silencioso (testes). O servidor passa o de `createLogger`. */
  logger?: Logger;
}

type ErrorStatus = 400 | 401 | 404 | 413 | 415 | 502;

/** Um webhook com histórico inteiro cabe com folga; acima disso é abuso ou erro. */
export const MAX_BODY_BYTES = 256 * 1024;

function fail(c: Context, status: ErrorStatus, code: string, message: string, details?: FieldIssue[]) {
  return c.json({ error: details ? { code, message, details } : { code, message } }, status);
}

/** Hook único dos validators: todo erro do zod vira o mesmo 400. */
const onInvalid = (result: { success: boolean; error?: unknown }, c: Context) => {
  if (!result.success) {
    const error = result.error as ZodError;
    return fail(c, 400, "validacao", summarize(error), issuesOf(error));
  }
};

const requireJson: MiddlewareHandler = async (c, next) => {
  if (!/^application\/([\w.+-]+\+)?json\b/i.test(c.req.header("content-type") ?? "")) {
    return fail(c, 415, "content_type_invalido", "o corpo precisa ser enviado com content-type: application/json");
  }
  await next();
};

function alertView(row: AlertRow) {
  return {
    id: row.id,
    shipment_id: row.shipment_id,
    kind: row.kind,
    details: JSON.parse(row.details),
    stale: row.stale === 1,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
  };
}

export function createApp(deps: AppDeps) {
  const { db } = deps;
  const logger = deps.logger ?? silentLogger;
  const service = new TrackingService(deps.db, deps.clock, deps.aggregator, deps.config);
  const app = new Hono();
  const supported = deps.aggregator.supportedCarriers;
  // A lista vem do adaptador: só ele sabe quais dialetos consegue traduzir.
  const createShipment = createShipmentBody.refine((body) => supported.includes(body.carrier), {
    path: ["carrier"],
    message: `transportadora não suportada; use uma de: ${supported.join(", ")}`,
  });

  // Resumo para listagens: sem histórico, para não fazer uma consulta por remessa.
  const shipmentSummary = (row: ShipmentRow) => ({
    id: row.id,
    carrier: row.carrier,
    tracking_code: row.tracking_code,
    aggregator_ref: row.aggregator_ref,
    status: row.status,
    status_since: row.status_since,
    transit_started_at: row.transit_started_at,
    delivered_at: row.delivered_at,
    content_due_at: service.contentDueAt(row),
    delayed: service.isDelayed(row),
    needs_review: row.needs_review === 1,
  });

  const shipmentView = (row: ShipmentRow) => ({
    id: row.id,
    carrier: row.carrier,
    tracking_code: row.tracking_code,
    aggregator_ref: row.aggregator_ref,
    status: row.status,
    status_since: row.status_since,
    transit_started_at: row.transit_started_at,
    delivered_at: row.delivered_at,
    content_due_at: service.contentDueAt(row),
    delayed: service.isDelayed(row),
    needs_review: row.needs_review === 1,
    events: db.listEvents(row.id).map((e) => ({
      status: e.status,
      raw_code: e.raw_code,
      description: e.description,
      location: e.location,
      occurred_at: e.occurred_at,
      ignored_reason: e.ignored_reason,
    })),
    status_changes: db.listStatusChanges(row.id).map((s) => ({ from: s.from_status, to: s.to_status, at: s.changed_at })),
    alerts: db.listAlerts(row.id).map(alertView),
  });

  app.onError((error, c) => {
    if (error instanceof NotFoundError) return fail(c, 404, "nao_encontrado", error.message);
    if (error instanceof InvalidSignatureError) return fail(c, 401, "assinatura_invalida", error.message);
    if (error instanceof InvalidPayloadError) return fail(c, 400, "payload_invalido", error.message, error.details);
    // O validator de JSON do Hono lança HTTPException 400 para corpo que não é JSON.
    if (error instanceof HTTPException && error.status === 400) {
      return fail(c, 400, "validacao", "o corpo não é JSON válido");
    }
    if (error instanceof AggregatorUnavailableError) return fail(c, 502, "agregador_indisponivel", error.message);
    if (error instanceof AggregatorResponseError) {
      return fail(c, 502, "agregador_resposta_invalida", error.message, error.details);
    }
    logger.error({ err: error, method: c.req.method, path: c.req.path }, "erro inesperado");
    return c.json({ error: { code: "erro_interno", message: "erro inesperado" } }, 500);
  });

  app.notFound((c) => fail(c, 404, "rota_inexistente", `rota ${c.req.method} ${c.req.path} não existe`));

  app.use(
    "*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => fail(c, 413, "corpo_grande_demais", `o corpo passa do limite de ${MAX_BODY_BYTES} bytes`),
    }),
  );

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/shipments", requireJson, zValidator("json", createShipment, onInvalid), async (c) => {
    const { tracking_code: trackingCode, carrier } = c.req.valid("json");
    const { shipment, created } = await service.register({ carrier, trackingCode });
    return c.json(shipmentView(shipment), created ? 201 : 200);
  });

  app.get("/shipments", zValidator("query", pageQuery, onInvalid), (c) => {
    const page = c.req.valid("query");
    return c.json({ ...page, shipments: db.listShipments(page.limit, page.offset).map(shipmentSummary) });
  });

  app.get("/shipments/:id", zValidator("param", shipmentIdParam, onInvalid), (c) => {
    const { id } = c.req.valid("param");
    const shipment = db.findShipment(id);
    if (!shipment) return fail(c, 404, "nao_encontrado", `remessa ${id} não encontrada`);
    return c.json(shipmentView(shipment));
  });

  app.post("/shipments/:id/refresh", zValidator("param", shipmentIdParam, onInvalid), async (c) => {
    const { shipment, newEvents } = await service.refresh(c.req.valid("param").id);
    return c.json({ new_events: newEvents, shipment: shipmentView(shipment) });
  });

  app.post("/webhooks/aggregator", async (c) => {
    // Corpo bruto: o cliente do agregador confere o HMAC sobre estes bytes e só depois valida com zod.
    const body = await c.req.text();
    const { shipment, newEvents } = service.ingestWebhook({ body, header: (name) => c.req.header(name) });
    return c.json({ new_events: newEvents, shipment_id: shipment.id, status: shipment.status });
  });

  app.post("/jobs/check-delays", async (c) => {
    const result = await service.checkDelays();
    return c.json({
      checked: result.checked,
      delayed: result.delayed,
      alerts_created: result.alertsCreated,
      stale_alerts: result.staleAlerts,
    });
  });

  app.get("/alerts", zValidator("query", alertsQuery, onInvalid), (c) => {
    const { include_resolved: includeResolved, ...page } = c.req.valid("query");
    const alerts = db.listAlertsPage(page.limit, page.offset, includeResolved).map(alertView);
    return c.json({ ...page, include_resolved: includeResolved, alerts });
  });

  return app;
}
