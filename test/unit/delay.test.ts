import { describe, expect, it } from "vitest";
import { isDelayed } from "../../src/domain/delay.ts";

const HOUR = 3_600_000;
const LIMIT = 72 * HOUR;
const start = new Date("2026-10-01T12:00:00.000Z");
const at = (ms: number) => new Date(start.getTime() + ms);

describe("isDelayed", () => {
  it("um milissegundo antes do limite não é atraso", () => {
    expect(isDelayed({ status: "em_transito", transitStartedAt: start }, at(LIMIT - 1), LIMIT)).toBe(false);
  });

  it("no limite exato ainda não é atraso", () => {
    expect(isDelayed({ status: "em_transito", transitStartedAt: start }, at(LIMIT), LIMIT)).toBe(false);
  });

  it("um milissegundo depois do limite é atraso", () => {
    expect(isDelayed({ status: "em_transito", transitStartedAt: start }, at(LIMIT + 1), LIMIT)).toBe(true);
  });

  it("entregue nunca é atraso, mesmo muito depois do limite", () => {
    expect(isDelayed({ status: "entregue", transitStartedAt: start }, at(30 * 24 * HOUR), LIMIT)).toBe(false);
  });

  it("exceção em aberto continua contando como trânsito", () => {
    expect(isDelayed({ status: "excecao", transitStartedAt: start }, at(LIMIT + 1), LIMIT)).toBe(true);
  });

  it("sem nenhum evento o relógio não começou", () => {
    expect(isDelayed({ status: null, transitStartedAt: null }, at(LIMIT * 10), LIMIT)).toBe(false);
  });
});
