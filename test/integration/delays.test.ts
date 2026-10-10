import { describe, expect, it } from "vitest";
import { FakeAggregatorClient } from "../../src/aggregator/fake/client.ts";
import { createFakeAggregatorApp } from "../../src/fake-aggregator/app.ts";
import { HOUR, setup, WEBHOOK_SECRET } from "./helpers.ts";

const POSTED_AT = "2026-10-01T12:00:00.000Z";
const LIMIT_HOURS = 72;
const limitReached = new Date(Date.parse(POSTED_AT) + LIMIT_HOURS * HOUR);

async function postedShipment(t: ReturnType<typeof setup>) {
  const s = await t.register();
  await t.carrierEvent(s.aggregator_ref, "Objeto postado", POSTED_AT);
  await t.call("POST", `/shipments/${s.id}/refresh`);
  return s;
}

describe("detecção de atraso com relógio controlado", () => {
  it("um milissegundo antes do limite não alerta", async () => {
    const t = setup({ delayLimitHours: LIMIT_HOURS, now: POSTED_AT });
    const s = await postedShipment(t);
    t.clock.set(new Date(limitReached.getTime() - 1));
    const res = await t.call("POST", "/jobs/check-delays");
    expect(res.body).toEqual({ checked: 1, delayed: [], alerts_created: [], stale_alerts: [] });
    expect((await t.call("GET", `/shipments/${s.id}`)).body.delayed).toBe(false);
  });

  it("no limite exato não alerta", async () => {
    const t = setup({ delayLimitHours: LIMIT_HOURS, now: POSTED_AT });
    await postedShipment(t);
    t.clock.set(limitReached);
    expect((await t.call("POST", "/jobs/check-delays")).body.alerts_created).toEqual([]);
  });

  it("um milissegundo depois do limite alerta e registra o alerta", async () => {
    const t = setup({ delayLimitHours: LIMIT_HOURS, now: POSTED_AT });
    const s = await postedShipment(t);
    t.clock.set(new Date(limitReached.getTime() + 1));
    const res = await t.call("POST", "/jobs/check-delays");
    expect(res.body.alerts_created).toEqual([s.id]);

    const shipment = (await t.call("GET", `/shipments/${s.id}`)).body;
    expect(shipment.delayed).toBe(true);
    expect(shipment.alerts).toHaveLength(1);
    expect(shipment.alerts[0]).toMatchObject({
      kind: "atraso",
      created_at: "2026-10-04T12:00:00.001Z",
      details: { status: "postado", needs_review: false, transit_started_at: POSTED_AT, limit_hours: 72, elapsed_hours: 72 },
    });
  });

  it("rodar o job de novo (inclusive em paralelo) não duplica o alerta", async () => {
    const t = setup({ delayLimitHours: LIMIT_HOURS, now: POSTED_AT });
    const s = await postedShipment(t);
    t.clock.set(new Date(limitReached.getTime() + HOUR));
    const runs = await Promise.all(Array.from({ length: 10 }, () => t.call("POST", "/jobs/check-delays")));
    expect(runs.flatMap((r) => r.body.alerts_created)).toEqual([s.id]);

    t.clock.advance(24 * HOUR);
    const later = await t.call("POST", "/jobs/check-delays");
    expect(later.body).toMatchObject({ delayed: [s.id], alerts_created: [] });
    expect((await t.call("GET", "/alerts")).body.alerts).toHaveLength(1);
  });

  it("entrega normal dentro do limite nunca vira atraso, nem muito depois", async () => {
    const t = setup({ delayLimitHours: LIMIT_HOURS, now: POSTED_AT });
    const s = await postedShipment(t);
    await t.carrierEvent(s.aggregator_ref, "Objeto em trânsito", "2026-10-02T12:00:00Z");
    await t.carrierEvent(s.aggregator_ref, "Objeto saiu para entrega ao destinatário", "2026-10-03T08:00:00Z");
    await t.carrierEvent(s.aggregator_ref, "Objeto entregue ao destinatário", "2026-10-03T15:00:00Z");
    t.clock.set("2026-10-03T16:00:00Z");
    await t.call("POST", `/shipments/${s.id}/refresh`);
    expect((await t.call("POST", "/jobs/check-delays")).body.checked).toBe(0);

    t.clock.set("2026-11-30T00:00:00Z");
    expect((await t.call("POST", "/jobs/check-delays")).body.alerts_created).toEqual([]);
    expect((await t.call("GET", `/shipments/${s.id}`)).body).toMatchObject({ status: "entregue", delayed: false });
  });

  it("exceção em aberto continua contando para o atraso", async () => {
    const t = setup({ delayLimitHours: LIMIT_HOURS, now: POSTED_AT });
    const s = await postedShipment(t);
    await t.carrierEvent(s.aggregator_ref, "Objeto não entregue - destinatário ausente", "2026-10-03T12:00:00Z");
    await t.call("POST", `/shipments/${s.id}/refresh`);
    t.clock.set(new Date(limitReached.getTime() + 1));
    expect((await t.call("POST", "/jobs/check-delays")).body.alerts_created).toEqual([s.id]);
  });

  it("evento antigo que chega depois antecipa o início do trânsito e pode revelar o atraso", async () => {
    const t = setup({ delayLimitHours: LIMIT_HOURS, now: "2026-10-04T13:00:00Z" });
    const s = await t.register();
    await t.carrierEvent(s.aggregator_ref, "Objeto em trânsito", "2026-10-03T12:00:00Z");
    await t.call("POST", `/shipments/${s.id}/refresh`);
    expect((await t.call("POST", "/jobs/check-delays")).body.alerts_created).toEqual([]);

    await t.carrierEvent(s.aggregator_ref, "Objeto postado", POSTED_AT);
    await t.call("POST", `/shipments/${s.id}/refresh`);
    expect((await t.call("POST", "/jobs/check-delays")).body.alerts_created).toEqual([s.id]);
  });
});

describe("fechamento do alerta", () => {
  it("entrega depois do alerta grava resolved_at e o alerta sai da lista padrão", async () => {
    const t = setup({ delayLimitHours: LIMIT_HOURS, now: POSTED_AT });
    const s = await postedShipment(t);
    t.clock.set(new Date(limitReached.getTime() + HOUR));
    await t.call("POST", "/jobs/check-delays");
    expect((await t.call("GET", "/alerts")).body.alerts).toHaveLength(1);

    await t.carrierEvent(s.aggregator_ref, "Objeto entregue ao destinatário", "2026-10-04T13:30:00Z");
    t.clock.set("2026-10-04T14:00:00Z");
    await t.call("POST", `/shipments/${s.id}/refresh`);

    const open = await t.call("GET", "/alerts");
    expect(open.body).toMatchObject({ include_resolved: false, alerts: [] });
    const all = await t.call("GET", "/alerts?include_resolved=true");
    expect(all.body.alerts).toHaveLength(1);
    expect(all.body.alerts[0]).toMatchObject({ shipment_id: s.id, resolved_at: "2026-10-04T14:00:00.000Z" });
    expect((await t.call("GET", `/shipments/${s.id}`)).body.alerts[0].resolved_at).toBe("2026-10-04T14:00:00.000Z");
  });

  it("evento novo que não é entrega mantém o alerta aberto", async () => {
    const t = setup({ delayLimitHours: LIMIT_HOURS, now: POSTED_AT });
    const s = await postedShipment(t);
    t.clock.set(new Date(limitReached.getTime() + HOUR));
    await t.call("POST", "/jobs/check-delays");
    await t.carrierEvent(s.aggregator_ref, "Objeto saiu para entrega ao destinatário", "2026-10-04T12:30:00Z");
    await t.call("POST", `/shipments/${s.id}/refresh`);
    expect((await t.call("GET", "/alerts")).body.alerts[0]).toMatchObject({ resolved_at: null });
  });

  it.each(["sim", "1", "TRUE"])("include_resolved=%s responde 400", async (value) => {
    const t = setup();
    expect((await t.call("GET", `/alerts?include_resolved=${value}`)).status).toBe(400);
  });
});

describe("reconsulta do agregador antes de alertar", () => {
  function withFlakyAggregator() {
    const fake = createFakeAggregatorApp();
    const state = { down: false, trackerCalls: 0 };
    const client = new FakeAggregatorClient({
      baseUrl: "http://agregador.test",
      webhookSecret: WEBHOOK_SECRET,
      fetch: async (url, init) => {
        if ((init?.method ?? "GET") === "GET") state.trackerCalls++;
        if (state.down) return new Response("fora do ar", { status: 503 });
        return fake.request(url, init);
      },
    });
    const t = setup({ aggregator: client, delayLimitHours: LIMIT_HOURS, now: POSTED_AT });
    const checkpoint = (ref: string, status: string, at: string) =>
      fake.request(`http://agregador.test/v1/trackers/${ref}/checkpoints`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ carrier_status: status, checkpoint_time: at }),
      });
    return { ...t, state, checkpoint };
  }

  async function posted(t: ReturnType<typeof withFlakyAggregator>) {
    const s = await t.register();
    await t.checkpoint(s.aggregator_ref, "Objeto postado", POSTED_AT);
    await t.call("POST", `/shipments/${s.id}/refresh`);
    return s;
  }

  it("entrega que só aparece na reconsulta evita o alerta", async () => {
    const t = withFlakyAggregator();
    const s = await posted(t);
    // O webhook da entrega se perdeu: o agregador sabe, a API ainda não.
    await t.checkpoint(s.aggregator_ref, "Objeto entregue ao destinatário", "2026-10-04T11:00:00Z");
    t.clock.set(new Date(limitReached.getTime() + 1));
    const res = await t.call("POST", "/jobs/check-delays");
    expect(res.body).toMatchObject({ delayed: [], alerts_created: [] });
    expect((await t.call("GET", `/shipments/${s.id}`)).body.status).toBe("entregue");
  });

  it("reconsulta que confirma o atraso cria alerta com stale false", async () => {
    const t = withFlakyAggregator();
    const s = await posted(t);
    t.clock.set(new Date(limitReached.getTime() + 1));
    const res = await t.call("POST", "/jobs/check-delays");
    expect(res.body).toMatchObject({ alerts_created: [s.id], stale_alerts: [] });
    expect((await t.call("GET", "/alerts")).body.alerts[0]).toMatchObject({ stale: false });
  });

  it("agregador fora do ar na reconsulta cria o alerta marcado stale", async () => {
    const t = withFlakyAggregator();
    const s = await posted(t);
    t.state.down = true;
    t.clock.set(new Date(limitReached.getTime() + 1));
    const res = await t.call("POST", "/jobs/check-delays");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ alerts_created: [s.id], stale_alerts: [s.id] });
    expect((await t.call("GET", "/alerts")).body.alerts[0]).toMatchObject({ shipment_id: s.id, stale: true });
  });

  it("remessa que já tem alerta não é reconsultada a cada rodada", async () => {
    const t = withFlakyAggregator();
    await posted(t);
    t.clock.set(new Date(limitReached.getTime() + 1));
    await t.call("POST", "/jobs/check-delays");
    const calls = t.state.trackerCalls;
    await t.call("POST", "/jobs/check-delays");
    await t.call("POST", "/jobs/check-delays");
    expect(t.state.trackerCalls).toBe(calls);
  });

  it("antes do limite o job não chama o agregador", async () => {
    const t = withFlakyAggregator();
    await posted(t);
    const calls = t.state.trackerCalls;
    t.clock.set(limitReached);
    await t.call("POST", "/jobs/check-delays");
    expect(t.state.trackerCalls).toBe(calls);
  });
});
