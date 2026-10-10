import { randomUUID } from "node:crypto";
import {
  AggregatorResponseError,
  AggregatorUnavailableError,
  InvalidPayloadError,
  type TrackingAggregator, type TrackingUpdate, type WebhookRequest } from "./aggregator/types.ts";
import type { Clock } from "./clock.ts";
import type { Db, EventRow, ShipmentRow } from "./db.ts";
import { contentDueAt, isDelayed } from "./domain/delay.ts";
import { deriveState, isTooFarInFuture, type NormalizedEvent, type StoredEvent } from "./domain/status.ts";

export interface TrackingConfig {
  /** Tempo máximo em trânsito antes de virar alerta de atraso. */
  delayLimitMs: number;
  /** Limite por transportadora; quem não está aqui usa o global. */
  delayLimitByCarrierMs?: ReadonlyMap<string, number>;
  /** Dias corridos, contados da entrega, para o criador publicar o conteúdo. Padrão: 7. */
  contentDueDays?: number;
  /** Quanto um evento pode estar à frente do relógio antes de ser ignorado. Padrão: 10 minutos. */
  futureToleranceMs?: number;
}

export const DEFAULT_FUTURE_TOLERANCE_MS = 10 * 60_000;
export const DEFAULT_CONTENT_DUE_DAYS = 7;

export class NotFoundError extends Error {}

export interface IngestResult {
  shipment: ShipmentRow;
  newEvents: number;
}

function rowToEvent(row: EventRow, status: EventRow["status"]): StoredEvent {
  return {
    ignoredReason: row.ignored_reason,
    key: row.event_key,
    status,
    rawCode: row.raw_code,
    description: row.description,
    location: row.location,
    occurredAt: new Date(row.occurred_at),
  };
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export class TrackingService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly aggregator: TrackingAggregator,
    readonly config: TrackingConfig,
  ) {}

  /** Cadastrar o mesmo código duas vezes devolve a remessa que já existe. */
  async register(input: { carrier: string; trackingCode: string }): Promise<{ shipment: ShipmentRow; created: boolean }> {
    const existing = this.db.findShipmentByCode(input.carrier, input.trackingCode);
    if (existing) return { shipment: existing, created: false };

    const { ref } = await this.aggregator.register(input);
    const created = this.db.insertShipment({
      id: `shp_${randomUUID()}`,
      carrier: input.carrier,
      tracking_code: input.trackingCode,
      aggregator_ref: ref,
      created_at: this.clock.now().toISOString(),
    });
    // Se outra requisição cadastrou no meio do caminho, o INSERT não fez nada e lemos a dela.
    const shipment = this.db.findShipmentByCode(input.carrier, input.trackingCode)!;
    return { shipment, created };
  }

  /** Polling: busca o histórico completo no agregador e aplica o que for novo. */
  async refresh(shipmentId: string): Promise<IngestResult> {
    const shipment = this.db.findShipment(shipmentId);
    if (!shipment) throw new NotFoundError(`remessa ${shipmentId} não encontrada`);
    const update = await this.aggregator.getTracking(shipment.aggregator_ref);
    const mismatch = this.mismatch(shipment, update);
    if (mismatch) throw new AggregatorResponseError(`agregador devolveu dados de outra remessa: ${mismatch}`);
    return this.apply(shipment.id, update.events);
  }

  /** Webhook: o cliente do agregador autentica e traduz; aqui só chega evento normalizado. */
  ingestWebhook(request: WebhookRequest): IngestResult {
    const update: TrackingUpdate = this.aggregator.parseWebhook(request);
    const shipment = this.db.findShipmentByRef(update.ref);
    if (!shipment) throw new NotFoundError(`nenhuma remessa cadastrada para a referência ${update.ref}`);
    const mismatch = this.mismatch(shipment, update);
    if (mismatch) throw new InvalidPayloadError(`webhook não confere com a remessa cadastrada: ${mismatch}`);
    return this.apply(shipment.id, update.events);
  }

  /**
   * Confere se o que o agregador mandou é mesmo desta remessa. A transportadora
   * importa porque o dialeto é escolhido por ela.
   */
  private mismatch(shipment: ShipmentRow, update: TrackingUpdate): string | null {
    if (update.ref !== shipment.aggregator_ref) {
      return `referência ${update.ref}, esperada ${shipment.aggregator_ref}`;
    }
    if (update.carrier !== undefined && update.carrier.trim().toLowerCase() !== shipment.carrier) {
      return `transportadora ${update.carrier} não confere com a cadastrada (${shipment.carrier})`;
    }
    if (update.trackingCode !== undefined && update.trackingCode.trim().toUpperCase() !== shipment.tracking_code) {
      return `código de rastreio ${update.trackingCode} não confere com o cadastrado (${shipment.tracking_code})`;
    }
    return null;
  }

  /**
   * Grava os eventos novos e recalcula o status a partir do histórico inteiro.
   * Recalcular do zero (em vez de "aplicar o evento ao status atual") é o que
   * torna o resultado independente da ordem de chegada. O recálculo roda mesmo
   * sem evento novo e retraduz cada `raw_code` com a tabela atual do adaptador.
   */
  private apply(shipmentId: string, events: readonly NormalizedEvent[]): IngestResult {
    const receivedAt = this.clock.now();
    const now = receivedAt.toISOString();
    const tolerance = this.config.futureToleranceMs ?? DEFAULT_FUTURE_TOLERANCE_MS;
    // A decisão é tomada na chegada e fica gravada: o mesmo evento reenviado depois cai no dedupe.
    const stored: StoredEvent[] = events.map((e) => ({
      ...e,
      ignoredReason: isTooFarInFuture(e.occurredAt, receivedAt, tolerance) ? "data_no_futuro" : null,
    }));
    return this.db.transaction(() => {
      const before = this.db.findShipment(shipmentId)!;
      const newEvents = this.db.insertEvents(shipmentId, stored, now);

      const rows = this.db.listEvents(shipmentId);
      const current = rows.map((row) => {
        const status = this.aggregator.mapStatus(before.carrier, row.raw_code);
        // O histórico fica: muda só a tradução, o texto original continua lá.
        if (status !== row.status) this.db.updateEventStatus(row.id, status);
        return rowToEvent(row, status);
      });
      const retranslated = current.some((e, i) => e.status !== rows[i].status);
      if (newEvents === 0 && !retranslated) return { shipment: before, newEvents };

      const state = deriveState(current);
      if (state.status !== null && state.status !== before.status) {
        this.db.insertStatusChange(shipmentId, before.status, state.status, now);
      }
      // Pacote chegou: o alerta de atraso fica no registro, mas deixa de estar aberto.
      if (state.status === "entregue" && before.status !== "entregue") this.db.resolveAlerts(shipmentId, now);
      this.db.updateShipmentState(shipmentId, {
        status: state.status,
        statusSince: iso(state.since),
        transitStartedAt: iso(state.transitStartedAt),
        deliveredAt: iso(state.deliveredAt),
        needsReview: state.needsReview,
        updatedAt: now,
      });
      return { shipment: this.db.findShipment(shipmentId)!, newEvents };
    });
  }

  contentDueAt(shipment: ShipmentRow): string | null {
    const deliveredAt = shipment.delivered_at ? new Date(shipment.delivered_at) : null;
    return iso(contentDueAt(deliveredAt, this.config.contentDueDays ?? DEFAULT_CONTENT_DUE_DAYS));
  }

  delayLimitFor(carrier: string): number {
    return this.config.delayLimitByCarrierMs?.get(carrier) ?? this.config.delayLimitMs;
  }

  isDelayed(shipment: ShipmentRow): boolean {
    return isDelayed(
      {
        status: shipment.status,
        transitStartedAt: shipment.transit_started_at ? new Date(shipment.transit_started_at) : null,
      },
      this.clock.now(),
      this.delayLimitFor(shipment.carrier),
    );
  }

  /**
   * Job de atraso. Pode rodar quantas vezes quiser: cada remessa gera no máximo um alerta.
   * Antes de criar um alerta novo, reconsulta o agregador: o pacote pode ter sido entregue
   * e o webhook não ter chegado. Se a consulta falhar, o alerta sai marcado como `stale`.
   */
  async checkDelays(): Promise<{ checked: number; delayed: string[]; alertsCreated: string[]; staleAlerts: string[] }> {
    const candidates = this.db.listShipmentsInTransit();
    const delayed: string[] = [];
    const alertsCreated: string[] = [];
    const staleAlerts: string[] = [];
    for (const candidate of candidates) {
      if (!this.isDelayed(candidate)) continue;
      if (this.db.hasAlert(candidate.id, "atraso")) {
        delayed.push(candidate.id);
        continue;
      }

      let shipment = candidate;
      let stale = false;
      try {
        shipment = (await this.refresh(candidate.id)).shipment;
      } catch (error) {
        if (!(error instanceof AggregatorUnavailableError || error instanceof AggregatorResponseError)) throw error;
        stale = true;
      }
      if (!this.isDelayed(shipment)) continue;
      delayed.push(shipment.id);

      const now = this.clock.now();
      const elapsedMs = now.getTime() - new Date(shipment.transit_started_at!).getTime();
      const created = this.db.insertAlert(
        shipment.id,
        "atraso",
        {
          status: shipment.status,
          needs_review: shipment.needs_review === 1,
          transit_started_at: shipment.transit_started_at,
          elapsed_hours: Math.round((elapsedMs / 3_600_000) * 10) / 10,
          limit_hours: this.delayLimitFor(shipment.carrier) / 3_600_000,
        },
        now.toISOString(),
        stale,
      );
      if (created) alertsCreated.push(shipment.id);
      if (created && stale) staleAlerts.push(shipment.id);
    }
    return { checked: candidates.length, delayed, alertsCreated, staleAlerts };
  }
}
