import { describe, expect, it } from "vitest";
import { deriveState, type EventStatus, type NormalizedEvent } from "../../src/domain/status.ts";

let seq = 0;
function ev(status: EventStatus, occurredAt: string, rawCode: string = status): NormalizedEvent {
  return { key: `k${++seq}`, status, rawCode, description: null, location: null, occurredAt: new Date(occurredAt) };
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

describe("deriveState", () => {
  it("sem eventos não tem status nem relógio de trânsito", () => {
    expect(deriveState([])).toMatchObject({ status: null, transitStartedAt: null, needsReview: false });
  });

  it("segue a progressão normal postado, em trânsito, saiu para entrega, entregue", () => {
    const events = [
      ev("postado", "2026-10-01T10:00:00Z"),
      ev("em_transito", "2026-10-02T10:00:00Z"),
      ev("saiu_para_entrega", "2026-10-03T08:00:00Z"),
      ev("entregue", "2026-10-03T15:00:00Z"),
    ];
    expect(deriveState(events)).toMatchObject({
      status: "entregue",
      deliveredAt: new Date("2026-10-03T15:00:00Z"),
      transitStartedAt: new Date("2026-10-01T10:00:00Z"),
    });
  });

  it("o resultado é o mesmo em qualquer ordem de chegada", () => {
    const events = [
      ev("postado", "2026-10-01T10:00:00Z"),
      ev("em_transito", "2026-10-02T10:00:00Z"),
      ev("excecao", "2026-10-02T18:00:00Z"),
      ev("saiu_para_entrega", "2026-10-03T08:00:00Z"),
      ev("desconhecido", "2026-10-03T09:00:00Z"),
    ];
    const expected = deriveState(events);
    expect(expected.status).toBe("saiu_para_entrega");
    for (const order of permutations(events)) {
      expect(deriveState(order)).toEqual(expected);
    }
  });

  it("evento antigo que chega depois não regride o status", () => {
    const current = [ev("postado", "2026-10-01T10:00:00Z"), ev("saiu_para_entrega", "2026-10-03T08:00:00Z")];
    const withLateOldEvent = [...current, ev("em_transito", "2026-10-02T10:00:00Z")];
    expect(deriveState(withLateOldEvent).status).toBe("saiu_para_entrega");
  });

  it("status desconhecido nunca vira entregue nem muda o status, mas pede revisão", () => {
    const events = [ev("em_transito", "2026-10-02T10:00:00Z"), ev("desconhecido", "2026-10-05T10:00:00Z", "Pacote teletransportado")];
    expect(deriveState(events)).toMatchObject({ status: "em_transito", needsReview: true });
  });

  it("só eventos desconhecidos deixam a remessa sem status e sem relógio de trânsito", () => {
    expect(deriveState([ev("desconhecido", "2026-10-02T10:00:00Z")])).toMatchObject({
      status: null,
      transitStartedAt: null,
      needsReview: true,
    });
  });

  it("exceção mais recente que o último avanço vira o status atual", () => {
    const events = [ev("em_transito", "2026-10-02T10:00:00Z"), ev("excecao", "2026-10-03T10:00:00Z")];
    expect(deriveState(events).status).toBe("excecao");
  });

  it("exceção é resolvida por um evento de progresso posterior a ela", () => {
    const events = [
      ev("saiu_para_entrega", "2026-10-03T08:00:00Z"),
      ev("excecao", "2026-10-03T12:00:00Z"),
      ev("em_transito", "2026-10-04T09:00:00Z"),
    ];
    // Volta a valer o maior avanço já alcançado: o status não regride para em_transito.
    expect(deriveState(events).status).toBe("saiu_para_entrega");
  });

  it("exceção antiga que chega atrasada não derruba um avanço posterior", () => {
    const events = [ev("em_transito", "2026-10-04T09:00:00Z"), ev("excecao", "2026-10-02T12:00:00Z")];
    expect(deriveState(events).status).toBe("em_transito");
  });

  it("no empate de horário entre exceção e avanço, a exceção prevalece", () => {
    const events = [ev("em_transito", "2026-10-04T09:00:00Z"), ev("excecao", "2026-10-04T09:00:00Z")];
    expect(deriveState(events).status).toBe("excecao");
  });

  it("entregue é terminal: exceção posterior fica no histórico mas não muda o status", () => {
    const events = [ev("entregue", "2026-10-04T09:00:00Z"), ev("excecao", "2026-10-05T09:00:00Z")];
    expect(deriveState(events)).toMatchObject({ status: "entregue", deliveredAt: new Date("2026-10-04T09:00:00Z") });
  });
});
