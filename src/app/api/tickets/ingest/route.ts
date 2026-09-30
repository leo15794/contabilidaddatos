import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { importBatches } from "@/db/schema";
import { isAllowedSender } from "@/lib/tickets/allowed-senders";
import { extractTicketData } from "@/lib/tickets/extract";
import { sendOpenWaText } from "@/lib/tickets/openwa-client";
import { saveImportAndReconcile } from "@/lib/import";

/**
 * Webhook que llama OpenWA (el gateway de WhatsApp self-hosted, corriendo
 * aparte en un VPS — ver openwa/) cada vez que llega un mensaje. Protegido
 * por la firma HMAC de OpenWA, no por la sesión de cookie de la app (por eso
 * está en PUBLIC_PATHS del proxy).
 *
 * Contrato exacto de OpenWA (docs/06-api-specification.md §6.6 del ZIP):
 *   body: { event, timestamp, sessionId, idempotencyKey, deliveryId, data }
 *   header: X-OpenWA-Signature: sha256=<hmac-sha256 del raw body>
 */

type OpenWaMedia = {
  mimetype: string;
  filename?: string;
  data?: string; // base64 inline
  omitted?: boolean;
  sizeBytes?: number;
};

type OpenWaMessageData = {
  id: string;
  from: string; // "<phone>@c.us"
  to: string;
  body: string;
  type: string;
  timestamp: number; // epoch segundos
  isGroup: boolean;
  fromMe: boolean;
  chatId: string;
  media?: OpenWaMedia;
};

type OpenWaWebhookPayload = {
  event: string;
  timestamp: string;
  sessionId: string;
  idempotencyKey: string;
  deliveryId: string;
  data: OpenWaMessageData;
};

function verifySignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader) return false;

  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  const signatureBuffer = Buffer.from(signatureHeader);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length) return false;

  return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
}

export async function POST(request: Request) {
  const secret = process.env.OPENWA_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[tickets/ingest] Falta OPENWA_WEBHOOK_SECRET en el servidor.");
    return Response.json({ error: "server_misconfigured" }, { status: 500 });
  }

  // Hay que verificar la firma sobre los bytes crudos EXACTOS, antes de parsear
  // el JSON — por eso leemos el body como texto, no con request.json().
  const rawBody = await request.text();
  const signature = request.headers.get("x-openwa-signature");

  if (!verifySignature(rawBody, signature, secret)) {
    return Response.json({ error: "invalid_signature" }, { status: 401 });
  }

  let payload: OpenWaWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  // Solo nos suscribimos a message.received al crear el webhook en OpenWA,
  // pero por las dudas ignoramos silenciosamente cualquier otro evento.
  if (payload.event !== "message.received") {
    return Response.json({ ok: true });
  }

  const { data, idempotencyKey } = payload;

  if (data.isGroup || data.fromMe) {
    return Response.json({ ok: true });
  }

  if (!data.media || !data.media.mimetype?.startsWith("image/")) {
    // No respondemos mensajes que no son fotos, para no ser invasivos con
    // números que no están en la lista blanca.
    return Response.json({ ok: true });
  }

  if (!isAllowedSender(data.from)) {
    // Silencioso a propósito: no le damos pistas a números no autorizados.
    console.warn(`Ticket de número no autorizado: ${data.from}`);
    return Response.json({ ok: true });
  }

  // Idempotencia: si ya procesamos esta entrega (reintento de OpenWA), no la duplicamos.
  const existing = await db
    .select({ id: importBatches.id })
    .from(importBatches)
    .where(and(eq(importBatches.source, "ticket"), eq(importBatches.filename, idempotencyKey)));
  if (existing.length > 0) {
    return Response.json({ ok: true });
  }

  if (!data.media.data) {
    // omitted: true (o directamente sin data) — no vino el contenido inline.
    await sendOpenWaText(
      data.from,
      "No me llegó bien la foto. ¿Podés volver a mandarla?",
    );
    return Response.json({ ok: true });
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(data.media.data, "base64");
  } catch {
    return Response.json({ error: "bad_image" }, { status: 400 });
  }

  const extraction = await extractTicketData(buffer, data.media.mimetype, data.body || undefined);

  if (!extraction.ok) {
    await sendOpenWaText(
      data.from,
      `No pude leer bien el ticket (${extraction.notes || "imagen poco clara"}). ¿Podés mandar una foto más clara, con el importe y la fecha bien visibles?`,
    );
    return Response.json({ ok: true });
  }

  const saved = await saveImportAndReconcile("ticket", idempotencyKey, extraction.merchant, {
    rows: [
      {
        date: extraction.date!,
        description: extraction.merchant || "Ticket sin nombre de comercio",
        amount: -extraction.amount!, // un ticket es siempre un egreso
        currency: "ARS",
        counterparty: [extraction.cuit, extraction.merchant].filter(Boolean).join(" - ") || undefined,
        raw: {
          whatsappMessageId: data.id,
          whatsappFrom: data.from,
          openwaDeliveryId: payload.deliveryId,
          extraction,
        },
      },
    ],
    warnings: [],
  });

  const matchedNow = saved.reconcile.exactMatches + saved.reconcile.cardStatementMatches;
  const dateStr = extraction.date!.toLocaleDateString("es-AR");
  const amountStr = extraction.amount!.toLocaleString("es-AR", { style: "currency", currency: "ARS" });

  const reply =
    matchedNow > 0
      ? `Cargado: ${amountStr} en ${extraction.merchant ?? "(comercio no identificado)"} el ${dateStr}. Encontré una factura/movimiento que coincide, quedó conciliado automáticamente. ✅`
      : `Cargado: ${amountStr} en ${extraction.merchant ?? "(comercio no identificado)"} el ${dateStr}. Todavía no tiene factura AFIP asociada — quedó pendiente en la revisión.`;

  await sendOpenWaText(data.from, reply);

  return Response.json({ ok: true });
}
