import { describe, expect, it } from "vitest";
import { signBody } from "../../src/aggregator/fake/signature.ts";
import { FakeAggregatorClient } from "../../src/aggregator/fake/client.ts";
import { createApp } from "../../src/app.ts";
import { FixedClock } from "../../src/clock.ts";
import { Db } from "../../src/db.ts";
import { createFakeAggregatorApp } from "../../src/fake-aggregator/app.ts";
import { HOUR, setup, WEBHOOK_SECRET } from "./helpers.ts";

async function forgedDelivery(t: ReturnType<typeof setup>) {
  const s = await t.register();
  return {
    s,
    payload: {
      tracker: {
        id: s.aggregator_ref,
        tracking_number: "QB123456789BR",
        carrier: "correios",
        checkpoints: [{ checkpoint_id: "x1", carrier_status: "Objeto entregue ao destinatário", checkpoint_time: "2026-10-10T10:00:00Z" }],
      },
    },
  };
}

describe("assinatura do webhook", () => {
  it("webhook com assinatura válida é aceito", async () => {
    const t = setup();
    const { payload } = await forgedDelivery(t);
    const res = await t.webhook(payload);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("entregue");
  });

  it("webhook sem assinatura responde 401 e não grava nada", async () => {
    const t = setup();
    const { s, payload } = await forgedDelivery(t);
    const res = await t.webhook(payload, null);
    expect(res.status).toBe(401);
    expect(res.body.error).toEqual({ code: "assinatura_invalida", message: "header x-aggregator-signature ausente" });
    expect((await t.call("GET", `/shipments/${s.id}`)).body).toMatchObject({ status: null, events: [] });
  });

  it("webhook com assinatura de outro segredo responde 401", async () => {
    const t = setup();
    const { s, payload } = await forgedDelivery(t);
    const res = await t.webhook(payload, signBody(JSON.stringify(payload), "segredo-errado"));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("assinatura_invalida");
    expect((await t.call("GET", `/shipments/${s.id}`)).body.status).toBeNull();
  });

  it("corpo alterado depois de assinado responde 401", async () => {
    const t = setup();
    const { payload } = await forgedDelivery(t);
    const signature = signBody(JSON.stringify({ ...payload, extra: 1 }), WEBHOOK_SECRET);
    expect((await t.webhook(payload, signature)).status).toBe(401);
  });

  it("o agregador fictício assina e entrega o webhook sozinho quando um checkpoint chega", async () => {
    const db = new Db(":memory:");
    let app: ReturnType<typeof createApp>;
    const fake = createFakeAggregatorApp({
      webhook: {
        secret: WEBHOOK_SECRET,
        send: (body, headers) => Promise.resolve(app.request("/webhooks/aggregator", { method: "POST", headers, body })),
      },
    });
    app = createApp({
      db,
      clock: new FixedClock("2026-10-10T12:00:00Z"),
      aggregator: new FakeAggregatorClient({
        baseUrl: "http://agregador.test",
        webhookSecret: WEBHOOK_SECRET,
        fetch: (url, init) => Promise.resolve(fake.request(url, init)),
      }),
      config: { delayLimitMs: 72 * HOUR },
    });

    const created = await app.request("/shipments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tracking_code: "LG555", carrier: "loggi" }),
    });
    const s = (await created.json()) as any;
    await fake.request(`http://agregador.test/v1/trackers/${s.aggregator_ref}/checkpoints`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ carrier_status: "picked_up", checkpoint_time: "2026-10-10T09:00:00Z" }),
    });

    const shipment = (await (await app.request(`/shipments/${s.id}`)).json()) as any;
    expect(shipment.status).toBe("postado");
    expect(shipment.events).toHaveLength(1);
  });
});
