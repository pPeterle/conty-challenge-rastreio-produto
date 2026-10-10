import {
  AggregatorUnavailableError,
  InvalidPayloadError,
  InvalidSignatureError,
  type TrackingAggregator,
  type TrackingUpdate,
  type WebhookRequest,
} from "../types.ts";
import { toNormalizedEvent } from "./mapping.ts";
import { isValidSignature, SIGNATURE_HEADER } from "./signature.ts";
import { issuesOf, summarize } from "../../validation.ts";
import { rawEnvelopeSchema, signatureSchema, type RawTracker } from "./schemas.ts";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FakeAggregatorClientOptions {
  baseUrl: string;
  /** Segredo compartilhado com o agregador para validar a assinatura dos webhooks. */
  webhookSecret: string;
  /** Permite injetar o fetch (nos testes ele aponta direto para o app fictício). */
  fetch?: FetchLike;
  timeoutMs?: number;
}

function parseTracker(body: unknown): RawTracker {
  const result = rawEnvelopeSchema.safeParse(body);
  if (!result.success) {
    throw new InvalidPayloadError(`payload do agregador inválido: ${summarize(result.error)}`, issuesOf(result.error));
  }
  return result.data.tracker;
}

function toUpdate(tracker: RawTracker): TrackingUpdate {
  return {
    ref: tracker.id,
    carrier: tracker.carrier,
    events: tracker.checkpoints.map((checkpoint) => toNormalizedEvent(tracker.carrier, checkpoint)),
  };
}

export class FakeAggregatorClient implements TrackingAggregator {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly webhookSecret: string;

  constructor(options: FakeAggregatorClientOptions) {
    if (!options.webhookSecret) throw new Error("webhookSecret é obrigatório");
    this.webhookSecret = options.webhookSecret;
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

  parseWebhook(request: WebhookRequest): TrackingUpdate {
    // A assinatura vale para os bytes recebidos: confere antes de qualquer parse.
    const header = request.header(SIGNATURE_HEADER);
    if (!header) throw new InvalidSignatureError(`header ${SIGNATURE_HEADER} ausente`);
    const signature = signatureSchema.safeParse(header);
    if (!signature.success) {
      throw new InvalidSignatureError(`header ${SIGNATURE_HEADER} com ${signature.error.issues[0].message}`);
    }
    if (!isValidSignature(request.body, signature.data, this.webhookSecret)) {
      throw new InvalidSignatureError(`assinatura do header ${SIGNATURE_HEADER} não confere com o corpo`);
    }
    let body: unknown;
    try {
      body = JSON.parse(request.body);
    } catch {
      throw new InvalidPayloadError("corpo não é JSON válido");
    }
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
