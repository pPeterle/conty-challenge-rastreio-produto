import { Hono } from "hono";
import { z } from "../validation.ts";
import { rawCheckpointSchema, registerTrackerSchema, type RawCheckpoint, type RawTracker } from "../aggregator/fake/schemas.ts";
import { SIGNATURE_HEADER, signBody } from "../aggregator/fake/signature.ts";
import { silentLogger, type Logger } from "../logger.ts";

export interface FakeAggregatorOptions {
  /** Se configurado, cada checkpoint novo dispara um webhook assinado com o histórico completo. */
  webhook?: {
    secret: string;
    send(body: string, headers: Record<string, string>): Promise<unknown>;
  };
  /** Padrão: silencioso (testes). */
  logger?: Logger;
}

/**
 * Agregador de rastreio fictício, em memória. Imita um serviço externo: cada
 * transportadora tem seu dialeto em `carrier_status` e a lista de checkpoints
 * volta na ordem em que foram registrados, não na ordem cronológica.
 */
export function createFakeAggregatorApp(options: FakeAggregatorOptions = {}) {
  const trackers = new Map<string, RawTracker>();
  const byCode = new Map<string, string>();
  let seq = 0;
  let checkpointSeq = 0;

  const logger = options.logger ?? silentLogger;
  const app = new Hono();
  // Sem isto o Hono escreveria o erro com console.error.
  app.onError((err, c) => {
    logger.error({ err, method: c.req.method, path: c.req.path }, "erro inesperado no agregador fictício");
    return c.json({ message: "internal error" }, 500);
  });

  app.post("/v1/trackers", async (c) => {
    const parsed = registerTrackerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ message: "tracking_number and carrier are required" }, 400);
    const { tracking_number: trackingNumber, carrier } = parsed.data;
    const codeKey = `${carrier}:${trackingNumber}`;
    const existing = byCode.get(codeKey);
    if (existing) return c.json({ tracker: trackers.get(existing) }, 200);

    const tracker: RawTracker = { id: `trk_${++seq}`, tracking_number: trackingNumber, carrier, checkpoints: [] };
    trackers.set(tracker.id, tracker);
    byCode.set(codeKey, tracker.id);
    return c.json({ tracker }, 201);
  });

  app.get("/v1/trackers/:id", (c) => {
    const tracker = trackers.get(c.req.param("id"));
    if (!tracker) return c.json({ message: "tracker not found" }, 404);
    return c.json({ tracker });
  });

  // Rota de simulação: é por aqui que testes e o script de carga "movem" o pacote.
  app.post("/v1/trackers/:id/checkpoints", async (c) => {
    const tracker = trackers.get(c.req.param("id"));
    if (!tracker) return c.json({ message: "tracker not found" }, 404);
    // O simulador aceita qualquer texto de data: é assim que os testes reproduzem um agregador que manda lixo.
    const parsed = rawCheckpointSchema
      .extend({ checkpoint_time: z.string().min(1) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ message: "carrier_status and checkpoint_time are required" }, 400);
    const body = parsed.data;
    const checkpoint: RawCheckpoint = {
      checkpoint_id: body.checkpoint_id ?? `cp_${++checkpointSeq}`,
      carrier_status: body.carrier_status,
      message: body.message ?? null,
      location: body.location ?? null,
      checkpoint_time: body.checkpoint_time,
    };
    tracker.checkpoints.push(checkpoint);
    if (options.webhook) {
      const payload = JSON.stringify({ tracker });
      // Um serviço real tentaria de novo; aqui a falha de entrega só é registrada.
      await options.webhook
        .send(payload, { "content-type": "application/json", [SIGNATURE_HEADER]: signBody(payload, options.webhook.secret) })
        .catch((error) => logger.warn({ tracker: tracker.id, motivo: (error as Error).message }, "webhook não entregue"));
    }
    return c.json({ checkpoint }, 201);
  });

  return app;
}
