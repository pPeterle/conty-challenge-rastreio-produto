/**
 * Conjunto estável de status que o resto do sistema conhece. Nada aqui sabe
 * de transportadora ou de agregador: quem traduz o dialeto deles é o adaptador.
 */
export const SHIPMENT_STATUSES = [
  "postado",
  "em_transito",
  "saiu_para_entrega",
  "entregue",
  "excecao",
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/**
 * Status de um evento individual. `desconhecido` é o código que o adaptador
 * não soube traduzir: fica no histórico, mas nunca muda o status da remessa.
 */
export type EventStatus = ShipmentStatus | "desconhecido";

/** Evento já traduzido. É o único formato de evento que o domínio enxerga. */
export interface NormalizedEvent {
  /** Identidade estável do evento, usada para deduplicar. */
  key: string;
  status: EventStatus;
  /** Código ou texto original da transportadora, guardado para auditoria. */
  rawCode: string;
  description: string | null;
  location: string | null;
  occurredAt: Date;
}

/** Motivo para um evento ficar no histórico mas fora do cálculo do status. */
export type IgnoredReason = "data_no_futuro";

/** Evento como fica guardado: o normalizado mais a decisão tomada quando ele chegou. */
export interface StoredEvent extends NormalizedEvent {
  ignoredReason: IgnoredReason | null;
}

/**
 * Evento datado além da tolerância depois do instante em que chegou. Relógio
 * errado na transportadora, fuso trocado ou dado forjado: nenhum desses deve
 * marcar uma etapa que ainda não aconteceu.
 */
export function isTooFarInFuture(occurredAt: Date, receivedAt: Date, toleranceMs: number): boolean {
  return occurredAt.getTime() - receivedAt.getTime() > toleranceMs;
}

type ProgressStatus = Exclude<ShipmentStatus, "excecao">;

/** Ordem de avanço. `excecao` fica fora: é um desvio, não uma etapa. */
const PROGRESS_RANK: Record<ProgressStatus, number> = {
  postado: 1,
  em_transito: 2,
  saiu_para_entrega: 3,
  entregue: 4,
};

export function progressRank(status: ShipmentStatus): number | null {
  return status === "excecao" ? null : PROGRESS_RANK[status];
}

export interface DerivedState {
  status: ShipmentStatus | null;
  /** Evento que determinou o status atual. */
  since: Date | null;
  /** Primeiro evento conhecido: é daqui que conta o tempo em trânsito. */
  transitStartedAt: Date | null;
  deliveredAt: Date | null;
  /** Há eventos que o adaptador não soube traduzir e alguém precisa olhar. */
  needsReview: boolean;
}

/**
 * Deriva o status atual a partir do conjunto de eventos, sem depender da ordem
 * em que chegaram. Regras:
 *
 * 1. `desconhecido` e evento com `ignoredReason` ficam de fora (só marcam `needsReview`).
 * 2. `entregue` é terminal: se existe, o status é `entregue`.
 * 3. O avanço é o maior rank entre os eventos de progresso. Um evento antigo
 *    que chega depois nunca diminui esse máximo, então o status não regride.
 * 4. `excecao` vale enquanto nenhum evento de progresso tiver `occurredAt`
 *    estritamente posterior à exceção mais recente. Empate fica com a exceção.
 */
export function deriveState(events: readonly (NormalizedEvent & { ignoredReason?: IgnoredReason | null })[]): DerivedState {
  let best: { rank: number; event: NormalizedEvent } | null = null;
  let latestProgress: NormalizedEvent | null = null;
  let latestException: NormalizedEvent | null = null;
  let delivered: NormalizedEvent | null = null;
  let first: NormalizedEvent | null = null;
  let needsReview = false;

  for (const event of events) {
    if (event.status === "desconhecido" || event.ignoredReason) {
      needsReview = true;
      continue;
    }
    if (!first || event.occurredAt < first.occurredAt) first = event;

    if (event.status === "excecao") {
      if (!latestException || event.occurredAt > latestException.occurredAt) latestException = event;
      continue;
    }

    const rank = PROGRESS_RANK[event.status];
    // No empate de rank fica o evento mais antigo: é quando a etapa foi alcançada.
    if (!best || rank > best.rank || (rank === best.rank && event.occurredAt < best.event.occurredAt)) {
      best = { rank, event };
    }
    if (!latestProgress || event.occurredAt > latestProgress.occurredAt) latestProgress = event;
    if (event.status === "entregue" && (!delivered || event.occurredAt < delivered.occurredAt)) {
      delivered = event;
    }
  }

  const base = {
    transitStartedAt: first?.occurredAt ?? null,
    deliveredAt: delivered?.occurredAt ?? null,
    needsReview,
  };

  if (delivered) return { ...base, status: "entregue", since: delivered.occurredAt };

  const exceptionIsOpen =
    latestException !== null && (latestProgress === null || latestProgress.occurredAt <= latestException.occurredAt);
  if (exceptionIsOpen) return { ...base, status: "excecao", since: latestException!.occurredAt };

  if (best) return { ...base, status: best.event.status as ShipmentStatus, since: best.event.occurredAt };

  return { ...base, status: null, since: null };
}
