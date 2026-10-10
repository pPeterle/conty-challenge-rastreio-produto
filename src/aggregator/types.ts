import type { NormalizedEvent } from "../domain/status.ts";

/**
 * Contrato com qualquer serviço de rastreio. Trocar de agregador é escrever
 * outra implementação desta interface; o resto do código não muda.
 */
export interface TrackingAggregator {
  /** Transportadoras cujo dialeto este agregador sabe traduzir. Cadastro fora da lista é recusado. */
  readonly supportedCarriers: readonly string[];
  /** Cadastra o código no agregador e devolve a referência dele. Deve ser idempotente. */
  register(input: { trackingCode: string; carrier: string }): Promise<{ ref: string }>;
  /** Consulta o histórico completo (polling). */
  getTracking(ref: string): Promise<TrackingUpdate>;
  /**
   * Autentica e traduz um webhook do agregador. Recebe o corpo bruto porque a
   * assinatura é calculada sobre os bytes, não sobre o JSON reinterpretado.
   * Lança InvalidSignatureError ou InvalidPayloadError.
   */
  parseWebhook(request: WebhookRequest): TrackingUpdate;
}

export interface TrackingUpdate {
  ref: string;
  /** Transportadora que o agregador informou, quando ele informa. */
  carrier?: string;
  /** Código de rastreio que o agregador devolveu, quando ele devolve. */
  trackingCode?: string;
  events: NormalizedEvent[];
}

export interface WebhookRequest {
  body: string;
  header(name: string): string | undefined;
}

export class InvalidPayloadError extends Error {
  constructor(
    message: string,
    readonly details?: Array<{ path: string; message: string }>,
  ) {
    super(message);
  }
}

export class InvalidSignatureError extends Error {}

export class AggregatorUnavailableError extends Error {}

/** O agregador respondeu, mas com algo que não dá para usar (HTML, formato errado, outra remessa). */
export class AggregatorResponseError extends Error {
  constructor(
    message: string,
    readonly details?: Array<{ path: string; message: string }>,
  ) {
    super(message);
  }
}
