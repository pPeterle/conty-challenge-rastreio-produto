import type { NormalizedEvent } from "../domain/status.ts";

/**
 * Contrato com qualquer serviço de rastreio. Trocar de agregador é escrever
 * outra implementação desta interface; o resto do código não muda.
 */
export interface TrackingAggregator {
  /** Cadastra o código no agregador e devolve a referência dele. Deve ser idempotente. */
  register(input: { trackingCode: string; carrier: string }): Promise<{ ref: string }>;
  /** Consulta o histórico completo (polling). */
  getTracking(ref: string): Promise<TrackingUpdate>;
  /** Traduz o corpo de um webhook do agregador. Lança InvalidPayloadError se não reconhecer. */
  parseWebhook(body: unknown): TrackingUpdate;
}

export interface TrackingUpdate {
  ref: string;
  events: NormalizedEvent[];
}

export class InvalidPayloadError extends Error {}

export class AggregatorUnavailableError extends Error {}
