import { z } from "../../validation.ts";

/** Formato bruto do agregador fictício. Os tipos saem daqui via z.infer. */

export const MAX_CHECKPOINTS = 500;

export const rawCheckpointSchema = z.object({
  checkpoint_id: z.string().trim().min(1).max(100).optional(),
  carrier_status: z.string().trim().min(1).max(200),
  message: z.string().max(1000).nullish(),
  location: z.string().max(200).nullish(),
  // Sem fuso o instante dependeria do TZ do servidor, então o fuso é obrigatório.
  checkpoint_time: z
    .string()
    .datetime({ offset: true })
    .refine((v) => !Number.isNaN(Date.parse(v)), "data inexistente"),
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
