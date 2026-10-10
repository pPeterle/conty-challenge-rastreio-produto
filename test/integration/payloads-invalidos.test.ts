import { describe, expect, it, vi } from "vitest";
import { MAX_CHECKPOINTS } from "../../src/aggregator/fake/schemas.ts";
import { SIGNATURE_HEADER, signBody } from "../../src/aggregator/fake/signature.ts";
import { MAX_BODY_BYTES } from "../../src/app.ts";
import { setup, WEBHOOK_SECRET } from "./helpers.ts";

type T = ReturnType<typeof setup>;

async function raw(t: T, method: string, path: string, body?: string, headers: Record<string, string> = {}) {
  const res = await t.app.request(path, { method, headers, body });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as any };
}

function signedWebhook(t: T, body: string) {
  return raw(t, "POST", "/webhooks/aggregator", body, {
    "content-type": "application/json",
    [SIGNATURE_HEADER]: signBody(body, WEBHOOK_SECRET),
  });
}

function expectError(res: { status: number; json: any; text: string }, status: number) {
  expect(res.status).toBe(status);
  expect(Object.keys(res.json)).toEqual(["error"]);
  expect(res.json.error).toMatchObject({ code: expect.any(String), message: expect.any(String) });
  if ("details" in res.json.error) {
    expect(res.json.error.details).toEqual(
      expect.arrayContaining([{ path: expect.any(String), message: expect.any(String) }]),
    );
  }
  expect(res.text).not.toMatch(/at .*\.ts:\d+/);
}

function counts(t: T) {
  const one = (sql: string) => (t.db.raw.prepare(sql).get() as { n: number }).n;
  return {
    shipments: one("SELECT COUNT(*) AS n FROM shipments"),
    events: one("SELECT COUNT(*) AS n FROM tracking_events"),
    changes: one("SELECT COUNT(*) AS n FROM status_changes"),
    alerts: one("SELECT COUNT(*) AS n FROM alerts"),
  };
}

const validCheckpoint = { checkpoint_id: "c1", carrier_status: "Objeto postado", checkpoint_time: "2026-10-01T10:00:00Z" };
const tracker = (ref: string, over: Record<string, unknown> = {}) => ({
  id: ref,
  tracking_number: "QB123456789BR",
  carrier: "correios",
  checkpoints: [validCheckpoint],
  ...over,
});
const withCheckpoint = (ref: string, over: Record<string, unknown>) =>
  JSON.stringify({ tracker: tracker(ref, { checkpoints: [{ ...validCheckpoint, ...over }] }) });

const SHIPMENT_BODIES: Array<[string, string]> = [
  ["corpo vazio", ""],
  ["JSON malformado", "{"],
  ["null", "null"],
  ["array", "[]"],
  ["string solta", '"QB123456789BR"'],
  ["número solto", "42"],
  ["NaN literal", '{"tracking_code": NaN, "carrier": "correios"}'],
  ["objeto vazio", "{}"],
  ["tracking_code número", '{"tracking_code": 123456789, "carrier": "correios"}'],
  ["tracking_code só espaços", '{"tracking_code": "    ", "carrier": "correios"}'],
  ["tracking_code com espaço no meio", '{"tracking_code": "QB 123 456", "carrier": "correios"}'],
  ["tracking_code com unicode", '{"tracking_code": "QBÇÃO12345", "carrier": "correios"}'],
  ["tracking_code enorme", JSON.stringify({ tracking_code: "A".repeat(41), carrier: "correios" })],
  ["tracking_code objeto", '{"tracking_code": {"a": 1}, "carrier": "correios"}'],
  ["carrier ausente", '{"tracking_code": "QB123456789BR"}'],
  ["carrier vazio", '{"tracking_code": "QB123456789BR", "carrier": ""}'],
  ["carrier número", '{"tracking_code": "QB123456789BR", "carrier": 7}'],
  ["carrier com espaço", '{"tracking_code": "QB123456789BR", "carrier": "cor reios"}'],
];

const WEBHOOK_BODIES = (ref: string): Array<[string, string]> => [
  ["corpo vazio", ""],
  ["JSON malformado", "{"],
  ["null", "null"],
  ["array", "[]"],
  ["string solta", '"oi"'],
  ["número enorme", "1e999"],
  ["tracker null", '{"tracker": null}'],
  ["tracker array", '{"tracker": []}'],
  ["tracker.id número", JSON.stringify({ tracker: tracker(ref, { id: 1 }) })],
  ["tracker.id vazio", JSON.stringify({ tracker: tracker(ref, { id: "" }) })],
  ["carrier ausente", JSON.stringify({ tracker: tracker(ref, { carrier: undefined }) })],
  ["checkpoints objeto", JSON.stringify({ tracker: tracker(ref, { checkpoints: { a: 1 } }) })],
  ["checkpoints string", JSON.stringify({ tracker: tracker(ref, { checkpoints: "x" }) })],
  ["checkpoint null", JSON.stringify({ tracker: tracker(ref, { checkpoints: [null] }) })],
  ["carrier_status número", withCheckpoint(ref, { carrier_status: 10 })],
  ["carrier_status só espaços", withCheckpoint(ref, { carrier_status: "   " })],
  ["carrier_status enorme", withCheckpoint(ref, { carrier_status: "x".repeat(201) })],
  ["checkpoint_time número", withCheckpoint(ref, { checkpoint_time: 1_760_000_000 })],
  ["checkpoint_time '1'", withCheckpoint(ref, { checkpoint_time: "1" })],
  ["checkpoint_time sem fuso", withCheckpoint(ref, { checkpoint_time: "2026-10-01T10:00:00" })],
  ["checkpoint_time impossível", withCheckpoint(ref, { checkpoint_time: "2026-13-45T99:99:99Z" })],
  ["checkpoint_id vazio", withCheckpoint(ref, { checkpoint_id: "" })],
  ["checkpoint_id só espaços", withCheckpoint(ref, { checkpoint_id: "   " })],
  ["checkpoint_time 30 de fevereiro", withCheckpoint(ref, { checkpoint_time: "2026-02-30T12:00:00Z" })],
  ["message enorme", withCheckpoint(ref, { message: "x".repeat(1001) })],
  ["tracking_number enorme", JSON.stringify({ tracker: tracker(ref, { tracking_number: "Q".repeat(101) }) })],
  ["carrier enorme", JSON.stringify({ tracker: tracker(ref, { carrier: "c".repeat(51) }) })],
  ["checkpoint_id número", withCheckpoint(ref, { checkpoint_id: 5 })],
  ["message objeto", withCheckpoint(ref, { message: { a: 1 } })],
  ["location enorme", withCheckpoint(ref, { location: "x".repeat(201) })],
  [
    `mais de ${MAX_CHECKPOINTS} eventos`,
    JSON.stringify({
      tracker: tracker(ref, {
        checkpoints: Array.from({ length: MAX_CHECKPOINTS + 1 }, (_, i) => ({ ...validCheckpoint, checkpoint_id: `c${i}` })),
      }),
    }),
  ],
];

describe("payloads inválidos em POST /shipments", () => {
  it.each(SHIPMENT_BODIES)("%s responde 400 sem gravar nada", async (_name, body) => {
    const t = setup();
    expectError(await raw(t, "POST", "/shipments", body, { "content-type": "application/json" }), 400);
    expect(counts(t).shipments).toBe(0);
  });

  it("campos extras são ignorados", async () => {
    const t = setup();
    const res = await raw(t, "POST", "/shipments", JSON.stringify({ tracking_code: "QB123456789BR", carrier: "correios", admin: true, status: "entregue" }), {
      "content-type": "application/json",
    });
    expect(res.status).toBe(201);
    expect(res.json.status).toBeNull();
  });

  it.each([undefined, "text/plain", "application/x-www-form-urlencoded"])(
    "content-type %s responde 415 sem gravar nada",
    async (contentType) => {
      const t = setup();
      const headers: Record<string, string> = contentType ? { "content-type": contentType } : {};
      const body = JSON.stringify({ tracking_code: "QB123456789BR", carrier: "correios" });
      expectError(await raw(t, "POST", "/shipments", body, headers), 415);
      expect(counts(t).shipments).toBe(0);
    },
  );

  it("erro de validação traz o caminho e o motivo de cada campo em português", async () => {
    const t = setup();
    const res = await raw(t, "POST", "/shipments", JSON.stringify({ tracking_code: 12 }), { "content-type": "application/json" });
    expect(res.status).toBe(400);
    expect(res.json.error).toEqual({
      code: "validacao",
      message: "tracking_code: esperado string, recebido number (e mais 1 problema(s))",
      details: [
        { path: "tracking_code", message: "esperado string, recebido number" },
        { path: "carrier", message: "campo obrigatório" },
      ],
    });
  });

  it("charset no content-type é aceito", async () => {
    const t = setup();
    const res = await raw(t, "POST", "/shipments", JSON.stringify({ tracking_code: "QB123456789BR", carrier: "correios" }), {
      "content-type": "application/json; charset=utf-8",
    });
    expect(res.status).toBe(201);
  });

  it("corpo acima do limite responde 413", async () => {
    const t = setup();
    const body = JSON.stringify({ tracking_code: "QB123456789BR", carrier: "correios", lixo: "x".repeat(MAX_BODY_BYTES) });
    expectError(await raw(t, "POST", "/shipments", body, { "content-type": "application/json" }), 413);
    expect(counts(t).shipments).toBe(0);
  });
});

describe("payloads inválidos em POST /webhooks/aggregator (assinados corretamente)", () => {
  it("nenhum caso inválido responde 5xx nem grava evento", async () => {
    const t = setup();
    const s = await t.register();
    const before = counts(t);
    for (const [name, body] of WEBHOOK_BODIES(s.aggregator_ref)) {
      const res = await signedWebhook(t, body);
      expect(res.status, name).toBe(400);
      expectError(res, 400);
    }
    expect(counts(t)).toEqual(before);
    expect(before).toMatchObject({ shipments: 1, events: 0, changes: 0, alerts: 0 });
  });

  it.each(WEBHOOK_BODIES("trk_1").map(([name]) => name))("%s responde 400", async (name) => {
    const t = setup();
    const s = await t.register();
    const body = WEBHOOK_BODIES(s.aggregator_ref).find(([n]) => n === name)![1];
    expectError(await signedWebhook(t, body), 400);
  });

  it("referência desconhecida responde 404 sem gravar", async () => {
    const t = setup();
    await t.register();
    expectError(await signedWebhook(t, JSON.stringify({ tracker: tracker("trk_999") })), 404);
    expect(counts(t).events).toBe(0);
  });

  it("campos extras no tracker e no checkpoint são ignorados", async () => {
    const t = setup();
    const s = await t.register();
    const body = JSON.stringify({
      tracker: tracker(s.aggregator_ref, { surprise: [1, 2], checkpoints: [{ ...validCheckpoint, extra: { deep: true } }] }),
      meta: "x",
    });
    const res = await signedWebhook(t, body);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ new_events: 1, status: "postado" });
  });

  it("corpo acima do limite responde 413 antes de qualquer processamento", async () => {
    const t = setup();
    const s = await t.register();
    const body = JSON.stringify({ tracker: tracker(s.aggregator_ref), lixo: "x".repeat(MAX_BODY_BYTES) });
    expectError(await signedWebhook(t, body), 413);
    expect(counts(t).events).toBe(0);
  });

  it.each([undefined, "", "lixo", "sha256=", "sha256=xyz", `sha256=${"a".repeat(63)}`, `md5=${"a".repeat(64)}`])(
    "assinatura %s responde 401 sem gravar",
    async (signature) => {
      const t = setup();
      const s = await t.register();
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (signature !== undefined) headers[SIGNATURE_HEADER] = signature;
      expectError(await raw(t, "POST", "/webhooks/aggregator", JSON.stringify({ tracker: tracker(s.aggregator_ref) }), headers), 401);
      expect(counts(t).events).toBe(0);
    },
  );

  it("erro de payload do agregador traz details com o caminho do campo", async () => {
    const t = setup();
    const s = await t.register();
    const res = await signedWebhook(t, withCheckpoint(s.aggregator_ref, { checkpoint_time: "1" }));
    expect(res.json.error.code).toBe("payload_invalido");
    expect(res.json.error.details).toEqual([
      { path: "tracker.checkpoints.0.checkpoint_time", message: "precisa ser data ISO 8601 com fuso (Z ou ±hh:mm)" },
    ]);
  });
});

describe("rotas, ids e paginação", () => {
  it.each([
    ["GET", "/nao-existe"],
    ["PUT", "/shipments"],
    ["DELETE", "/alerts"],
    ["PATCH", "/shipments/shp_1"],
    ["GET", "/shipments/shp_inexistente"],
    ["GET", `/shipments/${encodeURIComponent("id com espaço ✓")}`],
    ["POST", "/shipments/shp_inexistente/refresh"],
  ])("%s %s responde 404 JSON", async (method, path) => {
    const t = setup();
    expectError(await raw(t, method, path), 404);
  });

  it("id de rota longo demais responde 400", async () => {
    const t = setup();
    expectError(await raw(t, "GET", `/shipments/${"x".repeat(101)}`), 400);
  });

  it.each(["limit=0", "limit=-1", "limit=abc", "limit=1e3", "limit=201", "limit=1.5", "offset=-1", "offset=x", "limit=", "offset=99999999999999999999"])(
    "GET /shipments?%s responde 400",
    async (query) => {
      const t = setup();
      expectError(await raw(t, "GET", `/shipments?${query}`), 400);
      expectError(await raw(t, "GET", `/alerts?${query}`), 400);
    },
  );

  it("listagem respeita limit e offset e não traz o histórico", async () => {
    const t = setup();
    for (const code of ["AAAA1", "AAAA2", "AAAA3"]) {
      await t.register(code);
      t.clock.advance(1000);
    }
    const page = await raw(t, "GET", "/shipments?limit=2&offset=1");
    expect(page.status).toBe(200);
    expect(page.json).toMatchObject({ limit: 2, offset: 1 });
    expect(page.json.shipments.map((s: any) => s.tracking_code)).toEqual(["AAAA2", "AAAA3"]);
    expect(page.json.shipments[0].events).toBeUndefined();
  });

  it("erro inesperado vira 500 genérico, sem detalhe interno", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = setup({
      aggregator: {
        supportedCarriers: ["correios"],
        register: async () => {
          throw new Error("detalhe interno: senha do banco");
        },
        getTracking: async () => ({ ref: "x", events: [] }),
        parseWebhook: () => ({ ref: "x", events: [] }),
      },
    });
    const res = await raw(t, "POST", "/shipments", JSON.stringify({ tracking_code: "QB123456789BR", carrier: "correios" }), {
      "content-type": "application/json",
    });
    expect(res.status).toBe(500);
    expect(res.json).toEqual({ error: { code: "erro_interno", message: "erro inesperado" } });
    expect(res.text).not.toContain("senha");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
