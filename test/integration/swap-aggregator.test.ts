import { describe, expect, it } from "vitest";
import type { TrackingAggregator, TrackingUpdate, WebhookRequest } from "../../src/aggregator/types.ts";
import { InvalidPayloadError, InvalidSignatureError } from "../../src/aggregator/types.ts";
import { setup } from "./helpers.ts";

/**
 * Outro agregador, com outro formato ("parcel"/"history"/"code"), escrito só
 * dentro do teste. Se o domínio dependesse do formato do fictício, isto quebraria.
 */
class OtherAggregator implements TrackingAggregator {
  readonly supportedCarriers = ["qualquer"];
  private codes = new Map<string, string>();

  async register(input: { trackingCode: string }) {
    const ref = `other-${input.trackingCode}`;
    this.codes.set(ref, input.trackingCode);
    return { ref };
  }

  async getTracking(ref: string): Promise<TrackingUpdate> {
    return { ref, events: [] };
  }

  parseWebhook(request: WebhookRequest): TrackingUpdate {
    // Este agregador autentica por token fixo num header próprio.
    if (request.header("x-other-token") !== "token-ok") throw new InvalidSignatureError("token inválido");
    const body = JSON.parse(request.body);
    if (!body?.parcel) throw new InvalidPayloadError("sem parcel");
    const map: Record<string, "postado" | "entregue"> = { "10": "postado", "90": "entregue" };
    return {
      ref: body.parcel,
      events: body.history.map((h: any) => ({
        key: `${body.parcel}:${h.seq}`,
        status: map[h.code] ?? "desconhecido",
        rawCode: h.code,
        description: null,
        location: null,
        occurredAt: new Date(h.ts * 1000),
      })),
    };
  }
}

describe("troca de agregador", () => {
  it("outra implementação da interface funciona sem mudar API nem domínio", async () => {
    const t = setup({ aggregator: new OtherAggregator() });
    const s = await t.register("ABC12345", "qualquer");
    expect(s.aggregator_ref).toBe("other-ABC12345");

    const body = JSON.stringify({
      parcel: s.aggregator_ref,
      history: [
        { seq: 2, code: "90", ts: 1_760_000_000 },
        { seq: 1, code: "10", ts: 1_759_900_000 },
        { seq: 3, code: "77", ts: 1_760_100_000 },
      ],
    });
    const res = await t.app.request("/webhooks/aggregator", {
      method: "POST",
      headers: { "content-type": "application/json", "x-other-token": "token-ok" },
      body,
    });
    expect(await res.json()).toMatchObject({ new_events: 3, status: "entregue" });
    const shipment = (await t.call("GET", `/shipments/${s.id}`)).body;
    expect(shipment.events.map((e: any) => e.status)).toEqual(["postado", "entregue", "desconhecido"]);
  });
});
