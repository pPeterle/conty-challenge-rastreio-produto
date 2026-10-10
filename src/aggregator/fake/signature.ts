import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-aggregator-signature";

/** Assinatura no formato `sha256=<hex>`: HMAC-SHA256 do corpo bruto, byte a byte como chegou. */
export function signBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function isValidSignature(body: string, signature: string, secret: string): boolean {
  const expected = Buffer.from(signBody(body, secret));
  const received = Buffer.from(signature.trim());
  // timingSafeEqual exige o mesmo tamanho; tamanho diferente já é assinatura errada.
  return expected.length === received.length && timingSafeEqual(expected, received);
}
