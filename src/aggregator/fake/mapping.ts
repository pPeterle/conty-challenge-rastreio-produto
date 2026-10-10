import { createHash } from "node:crypto";
import type { EventStatus, NormalizedEvent } from "../../domain/status.ts";
import type { RawCheckpoint } from "./schemas.ts";

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "");
}

/**
 * Correios descreve em texto livre. O casamento é exato depois de normalizar
 * (sem acento, minúsculo, espaços colapsados, sem ponto final): um prefixo
 * deixaria "Objeto entregue ao destinatário errado" virar entregue. Texto que
 * não está aqui vira desconhecido e vai para revisão.
 */
const CORREIOS_TEXTS: Record<string, EventStatus> = {
  "objeto postado": "postado",
  "objeto postado apos o horario limite da unidade": "postado",
  "objeto em transito": "em_transito",
  "objeto em transito - por favor aguarde": "em_transito",
  "objeto encaminhado": "em_transito",
  "objeto saiu para entrega": "saiu_para_entrega",
  "objeto saiu para entrega ao destinatario": "saiu_para_entrega",
  "objeto entregue ao destinatario": "entregue",
  "objeto nao entregue - destinatario ausente": "excecao",
  "objeto nao entregue - endereco incorreto": "excecao",
  "objeto devolvido ao remetente": "excecao",
  "objeto entregue ao remetente": "excecao",
  "objeto extraviado": "excecao",
};

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
    case "correios":
      return CORREIOS_TEXTS[normalizeText(carrierStatus)] ?? "desconhecido";
    case "jadlog":
      return JADLOG_CODES[normalizeText(carrierStatus).toUpperCase()] ?? "desconhecido";
    case "loggi":
      return LOGGI_CODES[normalizeText(carrierStatus)] ?? "desconhecido";
    default:
      return "desconhecido";
  }
}

export function toNormalizedEvent(carrier: string, checkpoint: RawCheckpoint): NormalizedEvent {
  const occurredAt = new Date(checkpoint.checkpoint_time);
  const location = checkpoint.location?.trim() || null;
  const rawCode = checkpoint.carrier_status.trim();
  // Sem id do agregador (ou com id vazio), a identidade do evento é o que ele descreve: quando, o quê e onde.
  const key =
    checkpoint.checkpoint_id?.trim() ||
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
