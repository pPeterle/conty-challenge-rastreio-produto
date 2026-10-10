import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.ts";

const HOUR = 3_600_000;

describe("loadConfig", () => {
  it("limite por transportadora vem de DELAY_LIMIT_HOURS_<TRANSPORTADORA> e o global é o padrão", () => {
    const config = loadConfig({ DELAY_LIMIT_HOURS: "72", DELAY_LIMIT_HOURS_CORREIOS: "120", DELAY_LIMIT_HOURS_LOGGI: "24" });
    expect(config.tracking.delayLimitMs).toBe(72 * HOUR);
    expect(config.tracking.delayLimitByCarrierMs).toEqual(
      new Map([
        ["correios", 120 * HOUR],
        ["loggi", 24 * HOUR],
      ]),
    );
  });

  it("sem nenhuma variável usa 168 h para todas", () => {
    const config = loadConfig({});
    expect(config.tracking.delayLimitMs).toBe(168 * HOUR);
    expect(config.tracking.delayLimitByCarrierMs.size).toBe(0);
  });

  it.each(["0", "-5", "abc", ""])("DELAY_LIMIT_HOURS_JADLOG=%j é recusado", (value) => {
    expect(() => loadConfig({ DELAY_LIMIT_HOURS_JADLOG: value })).toThrow("DELAY_LIMIT_HOURS_JADLOG");
  });
});

describe("CONTENT_DUE_DAYS", () => {
  it("padrão 7 e aceita outro inteiro positivo", () => {
    expect(loadConfig({}).tracking.contentDueDays).toBe(7);
    expect(loadConfig({ CONTENT_DUE_DAYS: "15" }).tracking.contentDueDays).toBe(15);
  });

  it.each(["0", "1.5", "x"])("%j é recusado", (value) => {
    expect(() => loadConfig({ CONTENT_DUE_DAYS: value })).toThrow("CONTENT_DUE_DAYS");
  });
});
