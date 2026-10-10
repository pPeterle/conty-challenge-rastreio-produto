import { z } from "./validation.ts";

/**
 * Schemas de tudo que a API recebe. Campos extras são descartados (`strip`,
 * o padrão do zod). O formato do agregador tem schema dentro do adaptador,
 * para não vazar para cá.
 */

export const createShipmentBody = z.object({
  tracking_code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{4,40}$/, "precisa ter de 4 a 40 letras, números ou hífen"),
  carrier: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_-]{2,30}$/, "precisa ter de 2 a 30 letras, números, _ ou - (ex.: correios, jadlog, loggi)"),
});
export type CreateShipmentBody = z.infer<typeof createShipmentBody>;

export const MAX_PAGE = 200;
export const DEFAULT_PAGE = 50;

function intQuery(min: number, max: number) {
  const message = `precisa ser um inteiro entre ${min} e ${max}`;
  return z
    .string()
    .regex(/^\d+$/, message)
    .transform(Number)
    .pipe(z.number().int().safe(message).min(min, message).max(max, message));
}

export const pageQuery = z.object({
  limit: intQuery(1, MAX_PAGE)
    .optional()
    .transform((v) => v ?? DEFAULT_PAGE),
  offset: intQuery(0, Number.MAX_SAFE_INTEGER)
    .optional()
    .transform((v) => v ?? 0),
});

export const shipmentIdParam = z.object({
  id: z.string().trim().min(1).max(100),
});
