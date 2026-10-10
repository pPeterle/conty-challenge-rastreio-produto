import { describe, expect, it } from "vitest";
import { HOUR, setup } from "./helpers.ts";

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
    expect(res.body).toEqual({ checked: 1, delayed: [], alerts_created: [] });
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
