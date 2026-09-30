import Anthropic from "@anthropic-ai/sdk";
import { parseArDate, parseArNumber } from "@/lib/parsers/types";

export type TicketExtraction = {
  ok: boolean;
  date: Date | null;
  amount: number | null; // siempre positivo si se pudo leer; el signo (egreso) se aplica al guardar
  merchant: string | null;
  cuit: string | null;
  confidence: number; // 0-100
  notes: string;
};

const SUPPORTED_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const PROMPT = `Sos un asistente que lee fotos de tickets y facturas de compra en Argentina.
Del texto e imagen que se te manda, extraé ÚNICAMENTE estos datos, en JSON, sin texto alrededor:

{
  "date": "YYYY-MM-DD o null si no se ve",
  "amount": número (el total final pagado, sin separador de miles, con punto decimal) o null si no se ve con claridad,
  "merchant": "nombre del comercio/proveedor, o null",
  "cuit": "CUIT si aparece impreso (11 dígitos, solo números), o null",
  "confidence": número de 0 a 100 indicando qué tan seguro estás de la fecha y el importe,
  "notes": "cualquier aclaración breve (ítems principales, si está borroso, si es ilegible, etc.)"
}

Si la imagen no es un ticket/factura/comprobante de pago, o es ilegible, poné confidence en 0 y explicá por qué en notes.
Respondé SOLO el JSON, nada más.`;

export async function extractTicketData(
  imageBuffer: Buffer,
  mimeType: string,
  caption?: string,
): Promise<TicketExtraction> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      date: null,
      amount: null,
      merchant: null,
      cuit: null,
      confidence: 0,
      notes: "Falta configurar ANTHROPIC_API_KEY en el servidor.",
    };
  }

  const media_type = SUPPORTED_MIME.has(mimeType) ? mimeType : "image/jpeg";
  const client = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

  const userText = caption ? `${PROMPT}\n\nTexto que mandó la persona junto a la foto: "${caption}"` : PROMPT;

  let raw: string;
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: media_type as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                data: imageBuffer.toString("base64"),
              },
            },
            { type: "text", text: userText },
          ],
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    raw = textBlock && "text" in textBlock ? textBlock.text : "";
  } catch (err) {
    return {
      ok: false,
      date: null,
      amount: null,
      merchant: null,
      cuit: null,
      confidence: 0,
      notes: `Error llamando a la API de Anthropic: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return parseExtractionResponse(raw);
}

export function parseExtractionResponse(raw: string): TicketExtraction {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      ok: false,
      date: null,
      amount: null,
      merchant: null,
      cuit: null,
      confidence: 0,
      notes: "No se pudo interpretar la respuesta del modelo.",
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      date?: string | null;
      amount?: number | string | null;
      merchant?: string | null;
      cuit?: string | null;
      confidence?: number;
      notes?: string;
    };

    const date = parsed.date ? parseArDate(String(parsed.date)) : null;
    const amount =
      parsed.amount === null || parsed.amount === undefined
        ? null
        : Math.abs(typeof parsed.amount === "number" ? parsed.amount : parseArNumber(String(parsed.amount)));
    const confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;

    const ok = confidence >= 50 && date !== null && amount !== null && amount > 0;

    return {
      ok,
      date,
      amount,
      merchant: parsed.merchant || null,
      cuit: parsed.cuit || null,
      confidence,
      notes: parsed.notes || "",
    };
  } catch {
    return {
      ok: false,
      date: null,
      amount: null,
      merchant: null,
      cuit: null,
      confidence: 0,
      notes: "La respuesta del modelo no era JSON válido.",
    };
  }
}
