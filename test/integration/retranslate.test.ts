import { describe, expect, it } from "vitest";
import { FakeAggregatorClient } from "../../src/aggregator/fake/client.ts";
import type { EventStatus } from "../../src/domain/status.ts";
import { createFakeAggregatorApp } from "../../src/fake-aggregator/app.ts";
import { setup, WEBHOOK_SECRET } from "./helpers.ts";

/** Cliente real com uma tabela extra que o teste "publica" no meio do caminho, como num deploy. */
class ClientWithNewTexts extends FakeAggregatorClient {
  readonly extra = new Map<string, EventStatus>();

  override mapStatus(carrier: string, rawCode: string): EventStatus {
    return this.extra.get(rawCode) ?? super.mapStatus(carrier, rawCode);
  }
}

function build() {
  const fake = createFakeAggregatorApp();
  const client = new ClientWithNewTexts({
    baseUrl: "http://agregador.test",
    webhookSecret: WEBHOOK_SECRET,
    fetch: (url, init) => Promise.resolve(fake.request(url, init)),
  });
  const t = setup({ aggregator: client });
  const checkpoint = (ref: string, status: string, at: string) =>
    fake.request(`http://agregador.test/v1/trackers/${ref}/checkpoints`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ carrier_status: status, checkpoint_time: at }),
    });
  return { ...t, fake, client, checkpoint };
}

describe("tradução feita na hora do recálculo", () => {
  it("evento desconhecido passa a valer quando a tabela ganha o texto, sem perder o histórico", async () => {
    const t = build();
    const s = await t.register();
    await t.checkpoint(s.aggregator_ref, "Objeto postado", "2026-10-08T10:00:00Z");
    await t.checkpoint(s.aggregator_ref, "Objeto aguardando conferência na unidade", "2026-10-09T10:00:00Z");
    const before = (await t.call("POST", `/shipments/${s.id}/refresh`)).body.shipment;
    expect(before).toMatchObject({ status: "postado", needs_review: true });

    t.client.extra.set("Objeto aguardando conferência na unidade", "em_transito");
    const after = await t.call("POST", `/shipments/${s.id}/refresh`);
    expect(after.body.new_events).toBe(0);
    expect(after.body.shipment).toMatchObject({ status: "em_transito", needs_review: false });
    expect(after.body.shipment.events.map((e: any) => [e.status, e.raw_code])).toEqual([
      ["postado", "Objeto postado"],
      ["em_transito", "Objeto aguardando conferência na unidade"],
    ]);
    expect(after.body.shipment.status_changes.map((c: any) => c.to)).toEqual(["postado", "em_transito"]);
  });

  it("um webhook repetido também dispara a retradução", async () => {
    const t = build();
    const s = await t.register("LG123456", "loggi");
    const payload = {
      tracker: {
        id: s.aggregator_ref,
        tracking_number: "LG123456",
        carrier: "loggi",
        checkpoints: [{ checkpoint_id: "n1", carrier_status: "handed_to_neighbor", checkpoint_time: "2026-10-09T10:00:00Z" }],
      },
    };
    expect((await t.webhook(payload)).body.status).toBeNull();

    t.client.extra.set("handed_to_neighbor", "entregue");
    expect((await t.webhook(payload)).body).toMatchObject({ new_events: 0, status: "entregue" });
  });

  it("sem mudança na tabela, consultar de novo não grava nada nem muda status", async () => {
    const t = build();
    const s = await t.register();
    await t.checkpoint(s.aggregator_ref, "Objeto postado", "2026-10-08T10:00:00Z");
    await t.call("POST", `/shipments/${s.id}/refresh`);
    const again = (await t.call("POST", `/shipments/${s.id}/refresh`)).body.shipment;
    expect(again.status_changes).toHaveLength(1);
  });
});
