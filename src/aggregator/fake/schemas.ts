import { z } from "../../validation.ts";

/** Formato bruto do agregador fictício. Os tipos saem daqui via z.infer. */

export const MAX_CHECKPOINTS = 500;

/** Ida e volta pelo calendário: 2026-02-30 vira 2026-03-02 no Date, e isso denuncia a data inexistente. */
export function isRealCalendarDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
  if (!m) return false;
  const [y, mo, d, h, mi, s] = m.slice(1).map((part) => (part === undefined ? 0 : Number(part)));
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d &&
    date.getUTCHours() === h &&
    date.getUTCMinutes() === mi &&
    date.getUTCSeconds() === s
  );
}

export const rawCheckpointSchema = z.object({
  checkpoint_id: z.string().trim().min(1).max(100).optional(),
  carrier_status: z.string().trim().min(1).max(200),
  message: z.string().max(1000).nullish(),
  location: z.string().max(200).nullish(),
  // Sem fuso o instante dependeria do TZ do servidor, então o fuso é obrigatório.
  checkpoint_time: z
    .string()
    .datetime({ offset: true })
    // Só confere o calendário quando o formato já passou; senão o erro do formato basta.
    .refine(
      (v) => !/^\d{4}-\d{2}-\d{2}T/.test(v) || (isRealCalendarDate(v) && !Number.isNaN(Date.parse(v))),
      "data inexistente no calendário",
    ),
});

export const rawTrackerSchema = z.object({
  id: z.string().trim().min(1).max(100),
  tracking_number: z.string().trim().min(1).max(100),
  carrier: z.string().trim().min(1).max(50),
  checkpoints: z.array(rawCheckpointSchema).max(MAX_CHECKPOINTS),
});

export const rawEnvelopeSchema = z.object({ tracker: rawTrackerSchema });

export const registerTrackerSchema = rawTrackerSchema.pick({ tracking_number: true, carrier: true });

export const signatureSchema = z
  .string()
  .trim()
  .regex(/^sha256=[0-9a-f]{64}$/, "formato esperado: sha256=<64 dígitos hexadecimais>");

export type RawCheckpoint = z.infer<typeof rawCheckpointSchema>;
export type RawTracker = z.infer<typeof rawTrackerSchema>;
