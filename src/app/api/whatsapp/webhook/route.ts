import { db } from "@/db";
import { importBatches } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyWhatsappSignature } from "@/lib/whatsapp/verify";
import { getMediaUrl, downloadMedia, sendText, isAllowedSender } from "@/lib/whatsapp/client";
import { extractTicketData } from "@/lib/tickets/extract";
import { saveImportAndReconcile } from "@/lib/import";

// --- GET: handshake de verificación que pide Meta al registrar el webhook ---
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN && challenge) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

type WhatsappMessage = {
  from: string;
  id: string;
  type: string;
  image?: { id: string; mime_type: string; caption?: string };
};

type WhatsappWebhookBody = {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: WhatsappMessage[];
      };
    }>;
  }>;
};

// --- POST: acá llegan los mensajes reales ---
export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  if (!verifyWhatsappSignature(rawBody, signature)) {
    return new Response("Invalid signature", { status: 401 });
  }

  let body: WhatsappWebhookBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const messages = body.entry?.flatMap((e) => e.changes?.flatMap((c) => c.value?.messages ?? []) ?? []) ?? [];

  for (const message of messages) {
    try {
      await handleMessage(message);
    } catch (err) {
      console.error("Error procesando mensaje de WhatsApp:", err);
      // seguimos con los demás mensajes del batch aunque uno falle
    }
  }

  // Meta espera 200 rápido; ya procesamos todo lo que pudimos de forma síncrona.
  return new Response("OK", { status: 200 });
}

async function handleMessage(message: WhatsappMessage) {
  const from = message.from;

  if (!isAllowedSender(from)) {
    // Silencioso: no le damos pistas a números no autorizados de que el bot existe.
    console.warn(`Mensaje de WhatsApp de número no autorizado: ${from}`);
    return;
  }

  if (message.type !== "image" || !message.image) {
    await sendText(
      from,
      "Mandame una foto del ticket o la factura (como imagen, no como documento) y la cargo sola.",
    );
    return;
  }

  // Idempotencia: si ya procesamos este mensaje (reintento de Meta), no lo duplicamos.
  const existing = await db
    .select({ id: importBatches.id })
    .from(importBatches)
    .where(and(eq(importBatches.source, "ticket"), eq(importBatches.filename, message.id)));
  if (existing.length > 0) return;

  const mediaUrl = await getMediaUrl(message.image.id);
  const { buffer, mimeType } = await downloadMedia(mediaUrl);

  const extraction = await extractTicketData(buffer, mimeType, message.image.caption);

  if (!extraction.ok) {
    await sendText(
      from,
      `No pude leer bien el ticket (${extraction.notes || "imagen poco clara"}). ¿Podés mandar una foto más clara, con el importe y la fecha bien visibles?`,
    );
    return;
  }

  const saved = await saveImportAndReconcile(
    "ticket",
    message.id,
    extraction.merchant,
    {
      rows: [
        {
          date: extraction.date!,
          description: extraction.merchant || "Ticket sin nombre de comercio",
          amount: -extraction.amount!, // un ticket es siempre un egreso
          currency: "ARS",
          counterparty: [extraction.cuit, extraction.merchant].filter(Boolean).join(" - ") || undefined,
          raw: {
            whatsappMessageId: message.id,
            whatsappFrom: from,
            extraction,
          },
        },
      ],
      warnings: [],
    },
  );

  const matchedNow = saved.reconcile.exactMatches + saved.reconcile.cardStatementMatches;
  const dateStr = extraction.date!.toLocaleDateString("es-AR");
  const amountStr = extraction.amount!.toLocaleString("es-AR", { style: "currency", currency: "ARS" });

  await sendText(
    from,
    matchedNow > 0
      ? `Cargado: ${amountStr} en ${extraction.merchant ?? "(comercio no identificado)"} el ${dateStr}. Encontré una factura/movimiento que coincide, quedó conciliado automáticamente. ✅`
      : `Cargado: ${amountStr} en ${extraction.merchant ?? "(comercio no identificado)"} el ${dateStr}. Todavía no tiene factura AFIP asociada — quedó pendiente en la revisión.`,
  );
}
