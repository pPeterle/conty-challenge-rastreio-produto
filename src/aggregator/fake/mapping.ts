import { createHash } from "node:crypto";
import type { EventStatus, NormalizedEvent } from "../../domain/status.ts";
import type { RawCheckpoint } from "./schemas.ts";

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Correios descreve em texto livre e às vezes acrescenta complemento
 * ("Objeto em trânsito - por favor aguarde"), por isso o casamento é por prefixo.
 * "Entregue" só vale com o destinatário no texto: "Objeto entregue ao remetente"
 * ou "Objeto entregue na unidade de origem" não são entrega ao criador.
 */
const CORREIOS_PREFIXES: Array<[string, EventStatus]> = [
  ["objeto nao entregue", "excecao"],
  ["objeto devolvido", "excecao"],
  ["objeto entregue ao remetente", "excecao"],
  ["objeto extraviado", "excecao"],
  ["objeto postado", "postado"],
  ["objeto em transito", "em_transito"],
  ["objeto encaminhado", "em_transito"],
  ["objeto saiu para entrega", "saiu_para_entrega"],
  ["saiu para entrega", "saiu_para_entrega"],
  ["objeto entregue ao destinatario", "entregue"],
];

const JADLOG_CODES: Record<string, EventStatus> = {
  EMISSAO: "postado",
  COLETADO: "postado",
  TRANSFERENCIA: "em_transito",
  "EM ROTA": "saiu_para_entrega",
  ENTREGUE: "entregue",
  "DEVOLUCAO SOLICITADA": "excecao",
  "AVARIA": "excecao",
};

const LOGGI_CODES: Record<string, EventStatus> = {
  picked_up: "postado",
  in_transit: "em_transito",
  at_distribution_center: "em_transito",
  out_for_delivery: "saiu_para_entrega",
  delivered: "entregue",
  delivery_failed: "excecao",
  returned_to_sender: "excecao",
};

/** Qualquer código fora das tabelas vira `desconhecido`, nunca um palpite. */
export function mapCarrierStatus(carrier: string, carrierStatus: string): EventStatus {
  switch (carrier.toLowerCase()) {
    case "correios": {
      const text = normalizeText(carrierStatus);
      return CORREIOS_PREFIXES.find(([prefix]) => text.startsWith(prefix))?.[1] ?? "desconhecido";
    }
    case "jadlog":
      return JADLOG_CODES[carrierStatus.trim().toUpperCase()] ?? "desconhecido";
    case "loggi":
      return LOGGI_CODES[carrierStatus.trim().toLowerCase()] ?? "desconhecido";
    default:
      return "desconhecido";
  }
}

export function toNormalizedEvent(carrier: string, checkpoint: RawCheckpoint): NormalizedEvent {
  const occurredAt = new Date(checkpoint.checkpoint_time);
  const location = checkpoint.location?.trim() || null;
  const rawCode = checkpoint.carrier_status.trim();
  // Sem id do agregador, a identidade do evento é o que ele descreve: quando, o quê e onde.
  const key =
    checkpoint.checkpoint_id ??
    "h:" +
      createHash("sha256")
        .update(`${occurredAt.toISOString()}|${rawCode}|${location ?? ""}`)
        .digest("hex")
        .slice(0, 32);
  return {
    key,
    status: mapCarrierStatus(carrier, rawCode),
    rawCode,
    description: checkpoint.message?.trim() || null,
    location,
    occurredAt,
  };
}
