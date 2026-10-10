import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "../../src");
// Únicos lugares que podem conhecer o formato bruto do agregador fictício.
const ALLOWED = ["aggregator/fake/", "fake-aggregator/"];
// O index.ts é a raiz de composição: só instancia o cliente concreto.
const COMPOSITION_ROOT = "index.ts";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe("fronteira do agregador", () => {
  it("o formato do agregador não aparece fora do adaptador", () => {
    const leaks: string[] = [];
    for (const path of files(SRC)) {
      const rel = relative(SRC, path);
      if (ALLOWED.some((prefix) => rel.startsWith(prefix))) continue;
      const source = readFileSync(path, "utf8");
      if (/checkpoint|carrier_status|tracking_number|RawTracker/.test(source)) leaks.push(rel);
      if (rel !== COMPOSITION_ROOT && /aggregator\/fake\//.test(source)) leaks.push(rel);
    }
    expect(leaks).toEqual([]);
  });
});
