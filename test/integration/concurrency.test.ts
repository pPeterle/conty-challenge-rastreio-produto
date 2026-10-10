import { describe, expect, it } from "vitest";
import { progressRank, type ShipmentStatus } from "../../src/domain/status.ts";
import { setup } from "./helpers.ts";

// Gerador determinístico para embaralhar sem deixar o teste instável.
function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

describe("webhooks e polls concorrentes, repetidos e fora de ordem", () => {
  it("o histórico termina sem duplicatas e o status final é o correto", async () => {
    const t = setup();
    const s = await t.register("LG777", "loggi");
    const timeline: Array<[string, string]> = [
      ["picked_up", "2026-10-06T10:00:00Z"],
      ["in_transit", "2026-10-07T10:00:00Z"],
      ["delivery_failed", "2026-10-08T10:00:00Z"],
      ["teleported", "2026-10-08T11:00:00Z"],
      ["out_for_delivery", "2026-10-09T08:00:00Z"],
      ["delivered", "2026-10-09T15:00:00Z"],
    ];
    for (const [code, at] of timeline) await t.carrierEvent(s.aggregator_ref, code, at);
    const { tracker } = await t.rawTracker(s.aggregator_ref);

    const random = rng(42);
    const requests = Array.from({ length: 80 }, (_, i) => {
      if (i % 4 === 0) return t.call("POST", `/shipments/${s.id}/refresh`);
      // Cada webhook leva um subconjunto embaralhado, com repetição.
      const subset = shuffle(tracker.checkpoints, random).slice(0, 1 + Math.floor(random() * 4));
      return t.call("POST", "/webhooks/aggregator", { tracker: { ...tracker, checkpoints: [...subset, subset[0]] } });
    });
    const results = await Promise.all(requests);
    expect(results.every((r) => r.status === 200)).toBe(true);

    const final = (await t.call("GET", `/shipments/${s.id}`)).body;
    expect(final.events).toHaveLength(timeline.length);
    expect(final.status).toBe("entregue");
    expect(final.needs_review).toBe(true);

    // A sequência de mudanças nunca anda para trás no avanço.
    let maxRank = 0;
    for (const change of final.status_changes as Array<{ to: ShipmentStatus }>) {
      const rank = progressRank(change.to);
      if (rank === null) continue;
      expect(rank).toBeGreaterThanOrEqual(maxRank);
      maxRank = rank;
    }
  });
});
