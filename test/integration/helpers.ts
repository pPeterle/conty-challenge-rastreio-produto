import { FakeAggregatorClient } from "../../src/aggregator/fake/client.ts";
import { SIGNATURE_HEADER, signBody } from "../../src/aggregator/fake/signature.ts";
import type { TrackingAggregator } from "../../src/aggregator/types.ts";
import { createApp } from "../../src/app.ts";
import { FixedClock } from "../../src/clock.ts";
import { Db } from "../../src/db.ts";
import { createFakeAggregatorApp } from "../../src/fake-aggregator/app.ts";

export const HOUR = 3_600_000;
const AGG = "http://agregador.test";
export const WEBHOOK_SECRET = "segredo-de-teste";

export function setup(options: { delayLimitHours?: number; now?: string; aggregator?: TrackingAggregator } = {}) {
  const fake = createFakeAggregatorApp();
  const clock = new FixedClock(options.now ?? "2026-10-10T12:00:00.000Z");
  const db = new Db(":memory:");
  // O cliente HTTP real, com o fetch apontado para o app fictício em memória.
  const aggregator =
    options.aggregator ??
    new FakeAggregatorClient({ baseUrl: AGG, webhookSecret: WEBHOOK_SECRET, fetch: (url, init) => Promise.resolve(fake.request(url, init)) });
  const app = createApp({
    db,
    clock,
    aggregator,
    config: { delayLimitMs: (options.delayLimitHours ?? 72) * HOUR },
  });

  async function call(method: string, path: string, body?: unknown) {
    const res = await app.request(path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  /** Webhook como o agregador mandaria: corpo assinado com o segredo compartilhado. */
  async function webhook(payload: unknown, signature?: string | null) {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (signature !== null) headers[SIGNATURE_HEADER] = signature ?? signBody(body, WEBHOOK_SECRET);
    const res = await app.request("/webhooks/aggregator", { method: "POST", headers, body });
    return { status: res.status, body: (await res.json()) as any };
  }

  async function register(trackingCode = "QB123456789BR", carrier = "correios") {
    const res = await call("POST", "/shipments", { tracking_code: trackingCode, carrier });
    return res.body as { id: string; aggregator_ref: string };
  }

  /** Simula a transportadora registrando um checkpoint no agregador. */
  async function carrierEvent(ref: string, carrierStatus: string, at: string, extra: Record<string, unknown> = {}) {
    const res = await fake.request(`${AGG}/v1/trackers/${ref}/checkpoints`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ carrier_status: carrierStatus, checkpoint_time: at, location: "São Paulo/SP", ...extra }),
    });
    return ((await res.json()) as any).checkpoint;
  }

  async function rawTracker(ref: string) {
    const res = await fake.request(`${AGG}/v1/trackers/${ref}`);
    return (await res.json()) as any;
  }

  async function rawTrackerStatus(ref: string) {
    return (await fake.request(`${AGG}/v1/trackers/${ref}`)).status;
  }

  return { app, db, clock, fake, call, webhook, register, rawTrackerStatus, carrierEvent, rawTracker };
}
