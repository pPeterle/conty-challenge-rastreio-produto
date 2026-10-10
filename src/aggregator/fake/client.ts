import {
  AggregatorUnavailableError,
  InvalidPayloadError,
  type TrackingAggregator,
  type TrackingUpdate,
} from "../types.ts";
import { toNormalizedEvent } from "./mapping.ts";
import type { RawCheckpoint, RawTracker } from "./raw.ts";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FakeAggregatorClientOptions {
  baseUrl: string;
  /** Permite injetar o fetch (nos testes ele aponta direto para o app fictício). */
  fetch?: FetchLike;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCheckpoint(value: unknown): RawCheckpoint {
  if (!isRecord(value)) throw new InvalidPayloadError("checkpoint não é um objeto");
  const { checkpoint_id, carrier_status, message, location, checkpoint_time } = value;
  if (typeof carrier_status !== "string" || carrier_status.trim() === "") {
    throw new InvalidPayloadError("checkpoint sem carrier_status");
  }
  if (typeof checkpoint_time !== "string" || Number.isNaN(Date.parse(checkpoint_time))) {
    throw new InvalidPayloadError("checkpoint com checkpoint_time inválido");
  }
  if (checkpoint_id !== undefined && typeof checkpoint_id !== "string") {
    throw new InvalidPayloadError("checkpoint_id precisa ser texto");
  }
  return {
    checkpoint_id,
    carrier_status,
    message: typeof message === "string" ? message : null,
    location: typeof location === "string" ? location : null,
    checkpoint_time,
  };
}

function parseTracker(body: unknown): RawTracker {
  const tracker = isRecord(body) ? body.tracker : undefined;
  if (!isRecord(tracker)) throw new InvalidPayloadError("payload sem o objeto tracker");
  const { id, tracking_number, carrier, checkpoints } = tracker;
  if (typeof id !== "string" || typeof tracking_number !== "string" || typeof carrier !== "string") {
    throw new InvalidPayloadError("tracker precisa de id, tracking_number e carrier");
  }
  if (!Array.isArray(checkpoints)) throw new InvalidPayloadError("tracker.checkpoints precisa ser uma lista");
  return { id, tracking_number, carrier, checkpoints: checkpoints.map(parseCheckpoint) };
}

function toUpdate(tracker: RawTracker): TrackingUpdate {
  return {
    ref: tracker.id,
    events: tracker.checkpoints.map((checkpoint) => toNormalizedEvent(tracker.carrier, checkpoint)),
  };
}

export class FakeAggregatorClient implements TrackingAggregator {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: FakeAggregatorClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async register(input: { trackingCode: string; carrier: string }): Promise<{ ref: string }> {
    const body = await this.call("/v1/trackers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tracking_number: input.trackingCode, carrier: input.carrier }),
    });
    return { ref: parseTracker(body).id };
  }

  async getTracking(ref: string): Promise<TrackingUpdate> {
    const body = await this.call(`/v1/trackers/${encodeURIComponent(ref)}`, { method: "GET" });
    return toUpdate(parseTracker(body));
  }

  parseWebhook(body: unknown): TrackingUpdate {
    return toUpdate(parseTracker(body));
  }

  private async call(path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new AggregatorUnavailableError(`agregador inacessível: ${(error as Error).message}`);
    }
    if (!response.ok) {
      throw new AggregatorUnavailableError(`agregador respondeu ${response.status} em ${path}`);
    }
    try {
      return await response.json();
    } catch {
      throw new InvalidPayloadError("agregador respondeu algo que não é JSON");
    }
  }
}
