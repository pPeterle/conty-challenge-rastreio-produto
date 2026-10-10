import type { ShipmentStatus } from "./status.ts";

export interface DelayInput {
  status: ShipmentStatus | null;
  transitStartedAt: Date | null;
}

/**
 * Atrasou quando o tempo desde o primeiro evento passa ESTRITAMENTE do limite
 * e o pacote ainda não foi entregue. No limite exato ainda não é atraso.
 * Sem nenhum evento o relógio de trânsito nem começou.
 */
export function isDelayed(input: DelayInput, now: Date, limitMs: number): boolean {
  if (input.status === "entregue" || input.transitStartedAt === null) return false;
  return now.getTime() - input.transitStartedAt.getTime() > limitMs;
}

const DAY = 86_400_000;

/**
 * Prazo do conteúdo do criador: só começa quando o produto chega. Sem entrega,
 * não há prazo. Dias corridos a partir do instante da entrega.
 */
export function contentDueAt(deliveredAt: Date | null, days: number): Date | null {
  return deliveredAt ? new Date(deliveredAt.getTime() + days * DAY) : null;
}
