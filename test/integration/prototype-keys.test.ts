import { describe, expect, it } from "vitest";
import { setup } from "./helpers.ts";

const KEYS = ["constructor", "__proto__", "toString", "hasOwnProperty"];
const CARRIERS: Array<[string, string]> = [
  ["correios", "QB123456789BR"],
  ["jadlog", "JD000111222"],
  ["loggi", "LG123456"],
];

describe("carrier_status com nome de propriedade de Object.prototype", () => {
  it.each(CARRIERS)("refresh em %s grava como desconhecido e não derruba o lote", async (carrier, code) => {
    const t = setup();
    const s = await t.register(code, carrier);
    for (const [i, key] of KEYS.entries()) {
      await t.carrierEvent(s.aggregator_ref, key, `2026-10-0${i + 1}T10:00:00Z`);
    }
    const res = await t.call("POST", `/shipments/${s.id}/refresh`);
    expect(res.status).toBe(200);
    expect(res.body.new_events).toBe(KEYS.length);
    expect(res.body.shipment).toMatchObject({ status: null, needs_review: true });
    expect(res.body.shipment.events.map((e: any) => [e.status, e.raw_code])).toEqual(
      KEYS.map((key) => ["desconhecido", key]),
    );
  });

  it.each(CARRIERS)("webhook em %s grava como desconhecido junto com eventos válidos", async (carrier, code) => {
    const t = setup();
    const s = await t.register(code, carrier);
    const valid = { correios: "Objeto postado", jadlog: "EMISSAO", loggi: "picked_up" }[carrier]!;
    const res = await t.webhook({
      tracker: {
        id: s.aggregator_ref,
        tracking_number: code,
        carrier,
        checkpoints: [
          { checkpoint_id: "ok", carrier_status: valid, checkpoint_time: "2026-10-01T10:00:00Z" },
          ...KEYS.map((key, i) => ({ checkpoint_id: `p${i}`, carrier_status: key, checkpoint_time: "2026-10-02T10:00:00Z" })),
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ new_events: KEYS.length + 1, status: "postado" });
  });
});
