import { createHmac, timingSafeEqual } from "crypto";

/**
 * Verifica la firma que Meta manda en el header `X-Hub-Signature-256` sobre
 * el body crudo del request, usando el App Secret de la app de Meta.
 * https://developers.facebook.com/docs/graph-api/webhooks/getting-started#validating-payloads
 */
export function verifyWhatsappSignature(rawBody: string, signatureHeader: string | null): boolean {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) return false;
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;

  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const received = signatureHeader.slice("sha256=".length);

  const expectedBuf = Buffer.from(expected, "hex");
  const receivedBuf = Buffer.from(received, "hex");
  if (expectedBuf.length !== receivedBuf.length) return false;

  return timingSafeEqual(expectedBuf, receivedBuf);
}
