import { describe, expect, it } from "vitest";
import { FakeAggregatorClient } from "../../src/aggregator/fake/client.ts";
import { createFakeAggregatorApp } from "../../src/fake-aggregator/app.ts";
import { setup, WEBHOOK_SECRET } from "./helpers.ts";

/**
 * Agregador fictício de verdade, com um "defeito" que o teste liga quando quer:
 * a resposta seguinte é trocada pelo que o teste mandar.
 */
function brokenAggregator() {
  const fake = createFakeAggregatorApp();
  const state: { next: (() => Response) | null } = { next: null };
  const client = new FakeAggregatorClient({
    baseUrl: "http://agregador.test",
    webhookSecret: WEBHOOK_SECRET,
    fetch: async (url, init) => {
      const override = state.next;
      state.next = null;
      return override ? override() : fake.request(url, init);
    },
  });
  const t = setup({ aggregator: client, delayLimitHours: 72 });
  return { ...t, fake, breakNext: (fn: () => Response) => (state.next = fn) };
}

const html = () => new Response("<html><body>502 Bad Gateway</body></html>", { status: 200, headers: { "content-type": "text/html" } });
const json = (body: unknown) => () => Response.json(body);

async function addCheckpoint(t: ReturnType<typeof brokenAggregator>, ref: string, status: string, at: string) {
  await t.fake.request(`http://agregador.test/v1/trackers/${ref}/checkpoints`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ carrier_status: status, checkpoint_time: at }),
  });
}

describe("resposta inválida do agregador vira 502, não 400", () => {
  it("cadastro com resposta HTML responde 502 agregador_resposta_invalida e não grava remessa", async () => {
    const t = brokenAggregator();
    t.breakNext(html);
    const res = await t.call("POST", "/shipments", { tracking_code: "QB123456789BR", carrier: "correios" });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("agregador_resposta_invalida");
    expect((await t.call("GET", "/shipments")).body.shipments).toEqual([]);
  });

  it("cadastro com JSON em formato errado responde 502 com details", async () => {
    const t = brokenAggregator();
    t.breakNext(json({ ok: true }));
    const res = await t.call("POST", "/shipments", { tracking_code: "QB123456789BR", carrier: "correios" });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatchObject({ code: "agregador_resposta_invalida", details: [{ path: "tracker" }] });
  });

  it("cadastro em que o agregador devolve outro código responde 502", async () => {
    const t = brokenAggregator();
    t.breakNext(json({ tracker: { id: "trk_x", tracking_number: "OUTRO123", carrier: "correios", checkpoints: [] } }));
    const res = await t.call("POST", "/shipments", { tracking_code: "QB123456789BR", carrier: "correios" });
    expect(res.status).toBe(502);
    expect(res.body.error.message).toContain("OUTRO123");
  });

  it("refresh com resposta HTML responde 502 e mantém o histórico", async () => {
    const t = brokenAggregator();
    const s = await t.register();
    await addCheckpoint(t, s.aggregator_ref, "Objeto postado", "2026-10-09T10:00:00Z");
    await t.call("POST", `/shipments/${s.id}/refresh`);

    t.breakNext(html);
    const res = await t.call("POST", `/shipments/${s.id}/refresh`);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("agregador_resposta_invalida");
    expect((await t.call("GET", `/shipments/${s.id}`)).body).toMatchObject({ status: "postado", events: [{ status: "postado" }] });
  });

  it("refresh com checkpoint inválido na resposta responde 502", async () => {
    const t = brokenAggregator();
    const s = await t.register();
    t.breakNext(
      json({
        tracker: {
          id: s.aggregator_ref,
          tracking_number: "QB123456789BR",
          carrier: "correios",
          checkpoints: [{ carrier_status: "Objeto entregue ao destinatário", checkpoint_time: "ontem" }],
        },
      }),
    );
    const res = await t.call("POST", `/shipments/${s.id}/refresh`);
    expect(res.status).toBe(502);
    expect((await t.call("GET", `/shipments/${s.id}`)).body.events).toEqual([]);
  });

  it("agregador fora do ar (HTTP 500) continua 502 agregador_indisponivel", async () => {
    const t = brokenAggregator();
    const s = await t.register();
    t.breakNext(() => new Response("erro", { status: 500 }));
    const res = await t.call("POST", `/shipments/${s.id}/refresh`);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("agregador_indisponivel");
  });
});

describe("código de rastreio devolvido pelo agregador é conferido", () => {
  it("polling que devolve outro tracking_number responde 502 e não grava nada", async () => {
    const t = brokenAggregator();
    const s = await t.register();
    t.breakNext(
      json({
        tracker: {
          id: s.aggregator_ref,
          tracking_number: "OUTRO999BR",
          carrier: "correios",
          checkpoints: [{ checkpoint_id: "z", carrier_status: "Objeto entregue ao destinatário", checkpoint_time: "2026-10-09T10:00:00Z" }],
        },
      }),
    );
    const res = await t.call("POST", `/shipments/${s.id}/refresh`);
    expect(res.status).toBe(502);
    expect(res.body.error.message).toContain("OUTRO999BR não confere com o cadastrado (QB123456789BR)");
    expect((await t.call("GET", `/shipments/${s.id}`)).body).toMatchObject({ status: null, events: [] });
  });

  it("polling que devolve outra referência responde 502", async () => {
    const t = brokenAggregator();
    const s = await t.register();
    t.breakNext(json({ tracker: { id: "trk_outro", tracking_number: "QB123456789BR", carrier: "correios", checkpoints: [] } }));
    const res = await t.call("POST", `/shipments/${s.id}/refresh`);
    expect(res.status).toBe(502);
    expect(res.body.error.message).toContain("referência trk_outro");
  });

  it("webhook com tracking_number de outra remessa responde 400 e não grava nada", async () => {
    const t = setup();
    const s = await t.register();
    const res = await t.webhook({
      tracker: {
        id: s.aggregator_ref,
        tracking_number: "OUTRO999BR",
        carrier: "correios",
        checkpoints: [{ checkpoint_id: "z", carrier_status: "Objeto entregue ao destinatário", checkpoint_time: "2026-10-09T10:00:00Z" }],
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("payload_invalido");
    expect(res.body.error.message).toContain("OUTRO999BR");
    expect((await t.call("GET", `/shipments/${s.id}`)).body.events).toEqual([]);
  });

  it("tracking_number em minúsculas é o mesmo código", async () => {
    const t = setup();
    const s = await t.register();
    const res = await t.webhook({
      tracker: {
        id: s.aggregator_ref,
        tracking_number: "qb123456789br",
        carrier: "correios",
        checkpoints: [{ checkpoint_id: "z", carrier_status: "Objeto postado", checkpoint_time: "2026-10-09T10:00:00Z" }],
      },
    });
    expect(res.status).toBe(200);
  });

});

describe("fuso horário impossível no checkpoint_time", () => {
  const OFFSETS = ["+24:00", "+99:00", "+23:60", "-25:00", "-15:00", "+14:01", "+23:59"];
  const body = (ref: string, offset: string) => ({
    tracker: {
      id: ref,
      tracking_number: "QB123456789BR",
      carrier: "correios",
      checkpoints: [{ checkpoint_id: "f", carrier_status: "Objeto postado", checkpoint_time: `2026-10-01T10:00:00${offset}` }],
    },
  });

  it.each(OFFSETS)("webhook com fuso %s responde 400 sem gravar", async (offset) => {
    const t = setup();
    const s = await t.register();
    const res = await t.webhook(body(s.aggregator_ref, offset));
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([
      { path: "tracker.checkpoints.0.checkpoint_time", message: "fuso horário inválido (aceito de -14:00 a +14:00)" },
    ]);
    expect((await t.call("GET", `/shipments/${s.id}`)).body.events).toEqual([]);
  });

  it.each(OFFSETS)("polling com fuso %s responde 502 sem gravar", async (offset) => {
    const t = brokenAggregator();
    const s = await t.register();
    t.breakNext(json(body(s.aggregator_ref, offset)));
    const res = await t.call("POST", `/shipments/${s.id}/refresh`);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("agregador_resposta_invalida");
    expect((await t.call("GET", `/shipments/${s.id}`)).body.events).toEqual([]);
  });

  it.each(["+14:00", "-14:00", "-12:00", "+05:45"])("fuso %s válido é aceito", async (offset) => {
    const t = setup();
    const s = await t.register();
    expect((await t.webhook(body(s.aggregator_ref, offset))).status).toBe(200);
  });
});
