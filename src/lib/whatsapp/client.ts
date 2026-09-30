/**
 * Cliente fino sobre la WhatsApp Cloud API de Meta (Graph API).
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 */

const GRAPH_VERSION = "v21.0";

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

/** Dado un media id que llega en el webhook, resuelve la URL temporal de descarga. */
export async function getMediaUrl(mediaId: string): Promise<string> {
  const token = getEnv("WHATSAPP_ACCESS_TOKEN");
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`No se pudo resolver la URL del media ${mediaId}: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { url: string; mime_type: string };
  return data.url;
}

/** Descarga los bytes de un media de WhatsApp (la URL de getMediaUrl requiere el mismo token). */
export async function downloadMedia(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const token = getEnv("WHATSAPP_ACCESS_TOKEN");
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`No se pudo descargar el media: ${res.status} ${await res.text()}`);
  }
  const mimeType = res.headers.get("content-type") ?? "image/jpeg";
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mimeType };
}

/** Manda un mensaje de texto a un número (formato E.164 sin '+', como llega en el webhook). */
export async function sendText(to: string, body: string): Promise<void> {
  const token = getEnv("WHATSAPP_ACCESS_TOKEN");
  const phoneNumberId = getEnv("WHATSAPP_PHONE_NUMBER_ID");

  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      }),
    },
  );

  if (!res.ok) {
    // No relanzamos: si falla la respuesta al usuario, no queremos que eso
    // tire abajo el procesamiento del ticket que ya se guardó.
    console.error("Error enviando mensaje de WhatsApp:", res.status, await res.text());
  }
}

/** Teléfonos permitidos a mandar tickets, desde WHATSAPP_ALLOWED_NUMBERS (separados por coma). */
export function isAllowedSender(phone: string): boolean {
  const raw = process.env.WHATSAPP_ALLOWED_NUMBERS ?? "";
  const allowed = raw
    .split(",")
    .map((n) => n.trim().replace(/\D/g, ""))
    .filter(Boolean);
  if (allowed.length === 0) return false;
  return allowed.includes(phone.replace(/\D/g, ""));
}
