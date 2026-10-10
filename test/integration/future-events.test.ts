import { describe, expect, it } from "vitest";
import { setup } from "./helpers.ts";

const NOW = "2026-10-10T12:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();
const MIN = 60_000;

async function withPostado(t: ReturnType<typeof setup>) {
  const s = await t.register();
  await t.carrierEvent(s.aggregator_ref, "Objeto postado", "2026-10-09T10:00:00Z");
  await t.call("POST", `/shipments/${s.id}/refresh`);
  return s;
}

describe("evento com data no futuro", () => {
  it("exatamente na tolerância de 10 min ainda conta para o status", async () => {
    const t = setup({ now: NOW });
    const s = await withPostado(t);
    await t.carrierEvent(s.aggregator_ref, "Objeto em trânsito", at(10 * MIN));
    const res = await t.call("POST", `/shipments/${s.id}/refresh`);
    expect(res.body.shipment).toMatchObject({ status: "em_transito", needs_review: false });
  });

  it("1 ms além da tolerância fica no histórico, não muda o status e pede revisão", async () => {
    const t = setup({ now: NOW });
    const s = await withPostado(t);
    await t.carrierEvent(s.aggregator_ref, "Objeto entregue ao destinatário", at(10 * MIN + 1));
    const res = await t.call("POST", `/shipments/${s.id}/refresh`);
    expect(res.body.shipment).toMatchObject({ status: "postado", delivered_at: null, needs_review: true });
    expect(res.body.shipment.events.at(-1)).toMatchObject({ status: "entregue", ignored_reason: "data_no_futuro" });
  });

  it("evento do futuro não esconde o atraso", async () => {
    const t = setup({ now: NOW, delayLimitHours: 24 });
    const s = await withPostado(t);
    await t.carrierEvent(s.aggregator_ref, "Objeto entregue ao destinatário", "2026-10-20T10:00:00Z");
    await t.call("POST", `/shipments/${s.id}/refresh`);
    expect((await t.call("POST", "/jobs/check-delays")).body.alerts_created).toEqual([s.id]);
  });

  it("a decisão fica gravada: reenviar o mesmo evento depois que o relógio passa não o reativa", async () => {
    const t = setup({ now: NOW });
    const s = await withPostado(t);
    await t.carrierEvent(s.aggregator_ref, "Objeto entregue ao destinatário", at(60 * MIN));
    await t.call("POST", `/shipments/${s.id}/refresh`);

    t.clock.set(at(120 * MIN));
    const again = await t.call("POST", `/shipments/${s.id}/refresh`);
    expect(again.body.new_events).toBe(0);
    expect(again.body.shipment.status).toBe("postado");
  });

  it("o mesmo vale para o webhook", async () => {
    const t = setup({ now: NOW });
    const s = await t.register("LG123456", "loggi");
    const res = await t.webhook({
      tracker: {
        id: s.aggregator_ref,
        tracking_number: "LG123456",
        carrier: "loggi",
        checkpoints: [{ checkpoint_id: "f1", carrier_status: "delivered", checkpoint_time: "2027-01-01T00:00:00Z" }],
      },
    });
    expect(res.body).toMatchObject({ new_events: 1, status: null });
    expect((await t.call("GET", `/shipments/${s.id}`)).body).toMatchObject({ needs_review: true, transit_started_at: null });
  });
});
