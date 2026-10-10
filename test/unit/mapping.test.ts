import { describe, expect, it } from "vitest";
import { mapCarrierStatus, toNormalizedEvent } from "../../src/aggregator/fake/mapping.ts";

describe("tradução do dialeto de cada transportadora", () => {
  it.each([
    ["correios", "Objeto postado", "postado"],
    ["correios", "Objeto em trânsito - por favor aguarde", "em_transito"],
    ["correios", "objeto em transito", "em_transito"],
    ["correios", "  OBJETO   ENTREGUE ao destinatário.  ", "entregue"],
    ["correios", "Objeto saiu para entrega", "saiu_para_entrega"],
    ["correios", "Objeto saiu para entrega ao destinatário", "saiu_para_entrega"],
    ["correios", "Objeto entregue ao destinatário", "entregue"],
    ["correios", "Objeto não entregue - destinatário ausente", "excecao"],
    ["correios", "Objeto devolvido ao remetente", "excecao"],
    ["correios", "Objeto entregue ao remetente", "excecao"],
    ["jadlog", "EMISSAO", "postado"],
    ["jadlog", "TRANSFERENCIA", "em_transito"],
    ["jadlog", "EM ROTA", "saiu_para_entrega"],
    ["jadlog", "entregue", "entregue"],
    ["loggi", "picked_up", "postado"],
    ["loggi", "out_for_delivery", "saiu_para_entrega"],
    ["loggi", "delivered", "entregue"],
    ["loggi", "delivery_failed", "excecao"],
  ])("%s: %s vira %s", (carrier, raw, expected) => {
    expect(mapCarrierStatus(carrier, raw)).toBe(expected);
  });

  it.each([
    ["correios", "Objeto aguardando teletransporte"],
    ["correios", "Entregue ao vizinho, talvez"],
    ["correios", "Objeto entregue na unidade de origem para devolução"],
    ["correios", "Objeto entregue à transportadora"],
    ["correios", "Objeto entregue parcialmente"],
    ["correios", "Objeto entregue ao destinatário parcialmente"],
    ["correios", "Objeto entregue ao destinatario errado"],
    ["correios", "Objeto entregue ao destinatário? Não"],
    ["correios", "Objeto saiu para entrega - cancelada"],
    ["correios", "Objeto postado (dados incompletos)"],
    ["jadlog", "ENTREGUE?"],
    ["loggi", "delivered_maybe"],
    ["jadlog", "ENTREGUE PARCIAL"],
    ["loggi", "delivered_to_drone"],
    ["transportadora-nova", "delivered"],
  ])("status inventado %s / %s vira desconhecido, nunca entregue", (carrier, raw) => {
    expect(mapCarrierStatus(carrier, raw)).toBe("desconhecido");
  });

  it.each([
    "Objeto entregue ao remetente",
    "Objeto entregue na unidade de origem para devolução",
    "Objeto entregue à transportadora",
    "Objeto entregue ao destinatário parcialmente",
    "Objeto entregue ao destinatario errado",
    "Objeto entregue ao destinatário? Não",
  ])(
    "%s nunca vira entregue",
    (raw) => {
      expect(mapCarrierStatus("correios", raw)).not.toBe("entregue");
    },
  );

  it("usa o checkpoint_id como chave quando o agregador manda", () => {
    const event = toNormalizedEvent("correios", {
      checkpoint_id: "cp_9",
      carrier_status: "Objeto postado",
      checkpoint_time: "2026-10-01T10:00:00-03:00",
    });
    expect(event).toMatchObject({ key: "cp_9", status: "postado", occurredAt: new Date("2026-10-01T13:00:00Z") });
  });

  it("sem checkpoint_id, a chave é um hash estável de horário, código e local", () => {
    const raw = { carrier_status: "TRANSFERENCIA", location: "Curitiba/PR", checkpoint_time: "2026-10-01T10:00:00Z" };
    const a = toNormalizedEvent("jadlog", raw);
    // Mesmo instante escrito com outro fuso: é o mesmo evento.
    const b = toNormalizedEvent("jadlog", { ...raw, checkpoint_time: "2026-10-01T07:00:00-03:00" });
    const c = toNormalizedEvent("jadlog", { ...raw, location: "Joinville/SC" });
    // Espaço sobrando no código também não cria outro evento.
    const d = toNormalizedEvent("jadlog", { ...raw, carrier_status: "  TRANSFERENCIA " });
    expect(a.key).toBe(b.key);
    expect(d.key).toBe(a.key);
    expect(d.rawCode).toBe("TRANSFERENCIA");
    expect(a.key).not.toBe(c.key);
  });
});
