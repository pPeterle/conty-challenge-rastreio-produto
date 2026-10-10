import { describe, expect, it } from "vitest";
import { AggregatorUnavailableError } from "../../src/aggregator/types.ts";
import { setup } from "./helpers.ts";

describe("cadastro de código de rastreio", () => {
  it("cadastra o código no agregador e devolve a remessa sem status ainda", async () => {
    const t = setup();
    const res = await t.call("POST", "/shipments", { tracking_code: "qb123456789br", carrier: "Correios" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      carrier: "correios",
      tracking_code: "QB123456789BR",
      aggregator_ref: "trk_1",
      status: null,
      events: [],
      delayed: false,
    });
  });

  it("cadastrar o mesmo código de novo devolve a mesma remessa (200)", async () => {
    const t = setup();
    const first = await t.call("POST", "/shipments", { tracking_code: "QB123456789BR", carrier: "correios" });
    const again = await t.call("POST", "/shipments", { tracking_code: "QB123456789BR", carrier: "correios" });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
  });

  it("cadastros concorrentes do mesmo código criam uma única remessa", async () => {
    const t = setup();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => t.call("POST", "/shipments", { tracking_code: "JD000111222", carrier: "jadlog" })),
    );
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect((await t.call("GET", "/shipments")).body.shipments).toHaveLength(1);
  });

  it("valida o corpo e responde 400 com erro em português", async () => {
    const t = setup();
    const res = await t.call("POST", "/shipments", { tracking_code: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "validacao" });
  });

  it("remessa inexistente responde 404", async () => {
    const t = setup();
    expect((await t.call("GET", "/shipments/shp_nao_existe")).status).toBe(404);
    expect((await t.call("POST", "/shipments/shp_nao_existe/refresh")).status).toBe(404);
  });

  it("agregador fora do ar responde 502 sem quebrar a API", async () => {
    const t = setup({
      aggregator: {
        register: async () => {
          throw new AggregatorUnavailableError("agregador inacessível");
        },
        getTracking: async () => ({ ref: "x", events: [] }),
        parseWebhook: () => ({ ref: "x", events: [] }),
      },
    });
    const res = await t.call("POST", "/shipments", { tracking_code: "QB123456789BR", carrier: "correios" });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("agregador_indisponivel");
  });
});

describe("consulta (polling) e normalização", () => {
  it("traduz o payload bruto do agregador para o status normalizado", async () => {
    const t = setup();
    const s = await t.register();
    await t.carrierEvent(s.aggregator_ref, "Objeto postado", "2026-10-08T10:00:00-03:00");
    await t.carrierEvent(s.aggregator_ref, "Objeto em trânsito - por favor aguarde", "2026-10-09T08:00:00-03:00");

    const res = await t.call("POST", `/shipments/${s.id}/refresh`);
    expect(res.status).toBe(200);
    expect(res.body.new_events).toBe(2);
    expect(res.body.shipment).toMatchObject({
      status: "em_transito",
      transit_started_at: "2026-10-08T13:00:00.000Z",
      needs_review: false,
    });
    expect(res.body.shipment.events.map((e: any) => [e.status, e.raw_code])).toEqual([
      ["postado", "Objeto postado"],
      ["em_transito", "Objeto em trânsito - por favor aguarde"],
    ]);
  });

  it("consultar de novo o mesmo código não duplica o histórico", async () => {
    const t = setup();
    const s = await t.register();
    await t.carrierEvent(s.aggregator_ref, "Objeto postado", "2026-10-08T10:00:00-03:00");
    await t.call("POST", `/shipments/${s.id}/refresh`);

    const second = await t.call("POST", `/shipments/${s.id}/refresh`);
    const third = await t.call("POST", `/shipments/${s.id}/refresh`);
    expect(second.body.new_events).toBe(0);
    expect(third.body.shipment.events).toHaveLength(1);
    expect(third.body.shipment.status_changes).toHaveLength(1);
  });

  it("polls concorrentes do mesmo código gravam cada evento uma vez", async () => {
    const t = setup();
    const s = await t.register();
    await t.carrierEvent(s.aggregator_ref, "Objeto postado", "2026-10-08T10:00:00-03:00");
    await t.carrierEvent(s.aggregator_ref, "Objeto em trânsito", "2026-10-09T10:00:00-03:00");
    const results = await Promise.all(Array.from({ length: 30 }, () => t.call("POST", `/shipments/${s.id}/refresh`)));
    expect(results.reduce((sum, r) => sum + r.body.new_events, 0)).toBe(2);
    const final = (await t.call("GET", `/shipments/${s.id}`)).body;
    expect(final.events).toHaveLength(2);
    expect(final.status).toBe("em_transito");
  });
});

describe("eventos fora de ordem", () => {
  it("evento antigo que chega depois entra no histórico mas não regride o status", async () => {
    const t = setup();
    const s = await t.register();
    // A transportadora (ou o agregador) registra a saída para entrega antes do trânsito.
    await t.carrierEvent(s.aggregator_ref, "Objeto saiu para entrega ao destinatário", "2026-10-10T08:00:00-03:00");
    await t.call("POST", `/shipments/${s.id}/refresh`);

    await t.carrierEvent(s.aggregator_ref, "Objeto em trânsito", "2026-10-09T08:00:00-03:00");
    await t.carrierEvent(s.aggregator_ref, "Objeto postado", "2026-10-08T08:00:00-03:00");
    const res = await t.call("POST", `/shipments/${s.id}/refresh`);

    expect(res.body.new_events).toBe(2);
    expect(res.body.shipment.status).toBe("saiu_para_entrega");
    // O histórico sai em ordem cronológica, não de chegada.
    expect(res.body.shipment.events.map((e: any) => e.status)).toEqual(["postado", "em_transito", "saiu_para_entrega"]);
    // O começo do trânsito é corrigido pelo evento antigo.
    expect(res.body.shipment.transit_started_at).toBe("2026-10-08T11:00:00.000Z");
    expect(res.body.shipment.status_changes.map((c: any) => c.to)).toEqual(["saiu_para_entrega"]);
  });

  it("webhook com evento antigo depois do entregue não tira a remessa de entregue", async () => {
    const t = setup();
    const s = await t.register("LG123456", "loggi");
    const webhook = (checkpoints: unknown[]) =>
      t.webhook({
        tracker: { id: s.aggregator_ref, tracking_number: "LG123456", carrier: "loggi", checkpoints },
      });

    await webhook([{ checkpoint_id: "c3", carrier_status: "delivered", checkpoint_time: "2026-10-10T14:00:00Z" }]);
    const late = await webhook([
      { checkpoint_id: "c1", carrier_status: "picked_up", checkpoint_time: "2026-10-08T10:00:00Z" },
      { checkpoint_id: "c2", carrier_status: "out_for_delivery", checkpoint_time: "2026-10-10T09:00:00Z" },
    ]);
    expect(late.body).toMatchObject({ new_events: 2, status: "entregue" });
  });

  it("exceção é resolvida por avanço posterior e não volta com exceção antiga repetida", async () => {
    const t = setup();
    const s = await t.register();
    await t.carrierEvent(s.aggregator_ref, "Objeto em trânsito", "2026-10-08T10:00:00Z");
    await t.carrierEvent(s.aggregator_ref, "Objeto não entregue - destinatário ausente", "2026-10-09T10:00:00Z");
    expect((await t.call("POST", `/shipments/${s.id}/refresh`)).body.shipment.status).toBe("excecao");

    await t.carrierEvent(s.aggregator_ref, "Objeto saiu para entrega ao destinatário", "2026-10-10T08:00:00Z");
    const res = await t.call("POST", `/shipments/${s.id}/refresh`);
    expect(res.body.shipment.status).toBe("saiu_para_entrega");
    expect(res.body.shipment.status_changes.map((c: any) => c.to)).toEqual(["excecao", "saiu_para_entrega"]);
  });
});

describe("status que a transportadora inventou", () => {
  it("status desconhecido não vira entregue: fica no histórico como desconhecido e marca para revisão", async () => {
    const t = setup();
    const s = await t.register();
    await t.carrierEvent(s.aggregator_ref, "Objeto em trânsito", "2026-10-09T10:00:00Z");
    await t.carrierEvent(s.aggregator_ref, "Entregue ao vizinho, talvez", "2026-10-10T10:00:00Z");
    const res = await t.call("POST", `/shipments/${s.id}/refresh`);

    expect(res.body.shipment.status).toBe("em_transito");
    expect(res.body.shipment.delivered_at).toBeNull();
    expect(res.body.shipment.needs_review).toBe(true);
    expect(res.body.shipment.events.at(-1)).toMatchObject({
      status: "desconhecido",
      raw_code: "Entregue ao vizinho, talvez",
    });
  });

  it("remessa com só status desconhecidos não ganha status nem dispara atraso", async () => {
    const t = setup({ delayLimitHours: 1 });
    const s = await t.register("JD999", "jadlog");
    await t.carrierEvent(s.aggregator_ref, "ENTREGUE PARCIAL", "2026-10-01T10:00:00Z");
    const res = await t.call("POST", `/shipments/${s.id}/refresh`);
    expect(res.body.shipment).toMatchObject({ status: null, needs_review: true, transit_started_at: null });
    expect((await t.call("POST", "/jobs/check-delays")).body.alerts_created).toEqual([]);
  });
});

describe("webhook do agregador", () => {
  it("o mesmo webhook entregue várias vezes não duplica o histórico", async () => {
    const t = setup();
    const s = await t.register();
    await t.carrierEvent(s.aggregator_ref, "Objeto postado", "2026-10-09T10:00:00Z");
    const payload = await t.rawTracker(s.aggregator_ref);

    const first = await t.webhook(payload);
    const again = await t.webhook(payload);
    expect(first.body).toMatchObject({ new_events: 1, status: "postado" });
    expect(again.body).toMatchObject({ new_events: 0, status: "postado" });
  });

  it("webhook e polling trazendo o mesmo evento contam uma vez só", async () => {
    const t = setup();
    const s = await t.register();
    await t.carrierEvent(s.aggregator_ref, "Objeto postado", "2026-10-09T10:00:00Z");
    await t.webhook(await t.rawTracker(s.aggregator_ref));
    const poll = await t.call("POST", `/shipments/${s.id}/refresh`);
    expect(poll.body.new_events).toBe(0);
    expect(poll.body.shipment.events).toHaveLength(1);
  });

  it("checkpoint sem id é deduplicado pelo conteúdo", async () => {
    const t = setup();
    const s = await t.register("JD123", "jadlog");
    const payload = {
      tracker: {
        id: s.aggregator_ref,
        tracking_number: "JD123",
        carrier: "jadlog",
        checkpoints: [{ carrier_status: "TRANSFERENCIA", location: "Curitiba/PR", checkpoint_time: "2026-10-09T10:00:00Z" }],
      },
    };
    await t.webhook(payload);
    const again = await t.webhook(payload);
    expect(again.body.new_events).toBe(0);
  });

  it("payload em formato inesperado responde 400 e referência desconhecida responde 404", async () => {
    const t = setup();
    const bad = await t.webhook({ foo: "bar" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("payload_invalido");

    const unknown = await t.webhook({
      tracker: { id: "trk_404", tracking_number: "X", carrier: "correios", checkpoints: [] },
    });
    expect(unknown.status).toBe(404);
  });
});

describe("devolução ao remetente", () => {
  it("postado, devolvido e entregue ao remetente não viram entregue e o job de atraso continua avaliando", async () => {
    const t = setup({ delayLimitHours: 72, now: "2026-10-01T12:00:00Z" });
    const s = await t.register();
    await t.carrierEvent(s.aggregator_ref, "Objeto postado", "2026-10-01T12:00:00Z");
    await t.carrierEvent(s.aggregator_ref, "Objeto devolvido ao remetente", "2026-10-03T12:00:00Z");
    await t.carrierEvent(s.aggregator_ref, "Objeto entregue ao remetente", "2026-10-04T10:00:00Z");
    const res = await t.call("POST", `/shipments/${s.id}/refresh`);
    expect(res.body.shipment).toMatchObject({ status: "excecao", delivered_at: null });

    t.clock.set("2026-10-04T12:00:00.001Z");
    expect((await t.call("POST", "/jobs/check-delays")).body.alerts_created).toEqual([s.id]);
  });
});

describe("validação do payload do agregador", () => {
  const payload = (ref: string, checkpointTime: string, carrier = "correios") => ({
    tracker: {
      id: ref,
      tracking_number: "QB123456789BR",
      carrier,
      checkpoints: [{ checkpoint_id: "c1", carrier_status: "Objeto postado", checkpoint_time: checkpointTime }],
    },
  });

  it.each(["1", "2026-10-01", "2026-10-01T10:00:00", "2026-10-01 10:00:00Z", "ontem"])(
    "checkpoint_time %s sem formato ISO 8601 com fuso responde 400",
    async (checkpointTime) => {
      const t = setup();
      const s = await t.register();
      const res = await t.webhook(payload(s.aggregator_ref, checkpointTime));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("payload_invalido");
      expect((await t.call("GET", `/shipments/${s.id}`)).body.events).toEqual([]);
    },
  );

  it.each(["2026-10-01T10:00:00Z", "2026-10-01T07:00:00-03:00", "2026-10-01T10:00:00.123Z", "2026-10-01T10:00Z"])(
    "checkpoint_time %s é aceito",
    async (checkpointTime) => {
      const t = setup();
      const s = await t.register();
      expect((await t.webhook(payload(s.aggregator_ref, checkpointTime))).status).toBe(200);
    },
  );

  it("polling com checkpoint_time sem fuso é recusado como resposta inválida do agregador (502)", async () => {
    const t = setup();
    const s = await t.register();
    await t.carrierEvent(s.aggregator_ref, "Objeto postado", "2026-10-01T10:00:00");
    const res = await t.call("POST", `/shipments/${s.id}/refresh`);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("agregador_resposta_invalida");
  });

  it("webhook com transportadora diferente da cadastrada responde 400", async () => {
    const t = setup();
    const s = await t.register();
    const res = await t.webhook(payload(s.aggregator_ref, "2026-10-01T10:00:00Z", "loggi"));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("transportadora loggi não confere com a cadastrada (correios)");
  });
});
