import Anthropic from "@anthropic-ai/sdk";
import { ParseResult, ParsedRow, parseArDate } from "./types";

/**
 * Parser de resúmenes de tarjeta que NO tienen texto adentro (son una imagen
 * incrustada en el PDF — típico de resúmenes "descargados" que en realidad
 * son una captura de pantalla convertida a PDF con jsPDF o similar).
 *
 * `card-pdf.ts` (el parser genérico por texto) no puede leer estos archivos:
 * pdf-parse extrae cero caracteres. En vez de armar un pipeline de OCR
 * tradicional (tesseract confunde dígitos — "0" por "6"/"8" — que es
 * inaceptable en un documento con plata), se le manda el PDF directo a Claude
 * (la misma API que ya se usa para leer tickets en `tickets/extract.ts`), que
 * lo lee visualmente con mucha más precisión.
 *
 * Pensado específicamente para el formato de resumen de Visa Business/
 * Negocios XXI de Banco Macro, que trae VARIAS tarjetas adicionales en un
 * mismo resumen, cada una con su propio subtotal impreso ("TARJETA 9568
 * Total Consumos de NOMBRE $X"). Esos subtotales son el checksum: se suman
 * los consumos que Claude extrajo por tarjeta y se comparan contra el
 * subtotal impreso. Si no cierran exacto, esa tarjeta se marca para revisar
 * en vez de darla por buena en silencio.
 */

export type CardholderExtraction = {
  cardNumber: string;
  name: string;
  subtotalImpreso: number;
  consumos: {
    fecha: string; // "DD Mes AA" tal como viene en el resumen
    comprobante: string;
    descripcion: string;
    cuotas: string | null; // ej "3/6" o null si no es en cuotas
    importe: number;
  }[];
};

export type StatementExtraction = {
  emisor: string | null;
  cierre: string | null;
  vencimiento: string | null;
  saldoAnterior: number | null;
  saldoActual: number | null;
  pagoMinimo: number | null;
  cargosVarios: { descripcion: string; importe: number }[]; // impuestos, comisiones, IVA del resumen
  cardholders: CardholderExtraction[];
};

const PROMPT = `Sos un asistente que lee resúmenes de tarjeta de crédito argentinos (Banco Macro, formato "Visa Business"/"Negocios XXI") a partir de la imagen del PDF.

Este tipo de resumen trae VARIAS tarjetas adicionales en un mismo documento. Cada bloque de consumos de una tarjeta termina en una línea tipo:
"TARJETA 9568 Total Consumos de JUAN PABLO MACHADO    1704639,36 *    0,00 *"
Ahí "9568" es el número (parcial) de tarjeta, "JUAN PABLO MACHADO" el titular, y "1704639,36" el subtotal en pesos de esa tarjeta (ignorá la columna de u$s si está en 0,00).

Después de la última tarjeta vienen cargos del resumen en general (no de una tarjeta puntual): impuesto de sellos, comisión de mantenimiento, IVA, percepciones, etc. — cada uno con su importe.

Extraé TODO el contenido en este JSON, sin texto alrededor:

{
  "emisor": "nombre del banco/tarjeta tal como figura, o null",
  "cierre": "fecha de cierre tal como figura (ej '24 Sep 26'), o null",
  "vencimiento": "fecha de vencimiento tal como figura, o null",
  "saldoAnterior": número (saldo anterior del resumen) o null,
  "saldoActual": número (saldo actual / total a pagar) o null,
  "pagoMinimo": número o null,
  "cargosVarios": [ { "descripcion": "texto tal cual", "importe": número } ],
  "cardholders": [
    {
      "cardNumber": "los dígitos que acompañan a TARJETA",
      "name": "nombre del titular tal cual figura",
      "subtotalImpreso": número (el total impreso en la línea "Total Consumos de..."),
      "consumos": [
        {
          "fecha": "tal como figura en la línea, ej '27 Marzo 26'",
          "comprobante": "el número de comprobante/referencia",
          "descripcion": "la descripción del consumo, ej 'MERPAGO*ALEMANA'",
          "cuotas": "ej '3/6' si dice algo como C.03/06, o null si no es en cuotas",
          "importe": número (en pesos, positivo; ignorá la columna u$s si está vacía/0)
        }
      ]
    }
  ]
}

Reglas importantes:
- Todos los importes son números con punto decimal (no comas ni separador de miles), siempre positivos.
- Incluí TODAS las líneas de consumo de TODAS las tarjetas, no te saltees ninguna.
- No incluyas la línea "SALDO ANTERIOR" ni "SU PAGO EN..." como un consumo.
- Si una tarjeta no tiene consumos, igual incluila con "consumos": [].
- Respondé SOLO el JSON, nada de texto antes o después.`;

export async function parseCardStatementWithVision(
  fileBuffer: Buffer,
): Promise<ParseResult & { extraction: StatementExtraction | null; needsReview: boolean; reviewNotes: string[] }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      rows: [],
      warnings: ["Falta configurar ANTHROPIC_API_KEY en el servidor."],
      extraction: null,
      needsReview: true,
      reviewNotes: [],
    };
  }

  const client = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

  let raw: string;
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 8192,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: fileBuffer.toString("base64"),
              },
            },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    });
    const textBlock = response.content.find((b) => b.type === "text");
    raw = textBlock && "text" in textBlock ? textBlock.text : "";
  } catch (err) {
    return {
      rows: [],
      warnings: [`Error llamando a la API de Anthropic: ${err instanceof Error ? err.message : String(err)}`],
      extraction: null,
      needsReview: true,
      reviewNotes: [],
    };
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      rows: [],
      warnings: ["No se pudo interpretar la respuesta del modelo al leer el PDF."],
      extraction: null,
      needsReview: true,
      reviewNotes: [],
    };
  }

  let extraction: StatementExtraction;
  try {
    extraction = JSON.parse(jsonMatch[0]) as StatementExtraction;
  } catch {
    return {
      rows: [],
      warnings: ["La respuesta del modelo no era JSON válido."],
      extraction: null,
      needsReview: true,
      reviewNotes: [],
    };
  }

  const warnings: string[] = [];
  const reviewNotes: string[] = [];
  let needsReview = false;
  const rows: ParsedRow[] = [];

  for (const ch of extraction.cardholders ?? []) {
    const sum = ch.consumos.reduce((acc, c) => acc + c.importe, 0);
    const diff = Math.abs(sum - ch.subtotalImpreso);
    const checksumOk = diff < 1;
    if (!checksumOk) {
      needsReview = true;
      reviewNotes.push(
        `Tarjeta ${ch.cardNumber} (${ch.name}): la suma de los consumos extraídos ($${sum.toFixed(2)}) no coincide con el subtotal impreso ($${ch.subtotalImpreso.toFixed(2)}, diferencia $${diff.toFixed(2)}) — revisar a mano contra el PDF.`,
      );
    }

    for (const c of ch.consumos) {
      const date = parseArDate(normalizeFecha(c.fecha));
      if (!date) {
        warnings.push(`Fecha no interpretada en consumo de ${ch.name}: "${c.fecha}" (${c.descripcion}) — se omite.`);
        continue;
      }
      rows.push({
        date,
        description: c.descripcion,
        amount: -Math.abs(c.importe),
        currency: "ARS",
        counterparty: c.descripcion,
        raw: {
          cardNumber: ch.cardNumber,
          cardholder: ch.name,
          comprobante: c.comprobante,
          cuotas: c.cuotas,
          checksumOk,
          subtotalImpreso: ch.subtotalImpreso,
        },
      });
    }
  }

  for (const cargo of extraction.cargosVarios ?? []) {
    rows.push({
      date: parseArDate(normalizeFecha(extraction.cierre ?? "")) ?? new Date(),
      description: cargo.descripcion,
      amount: -Math.abs(cargo.importe),
      currency: "ARS",
      counterparty: "Banco (cargo del resumen)",
      raw: { cargoDelResumen: true, descripcion: cargo.descripcion },
    });
  }

  return { rows, warnings, extraction, needsReview, reviewNotes };
}

// "27 Marzo 26" -> "27/03/2026" (parseArDate ya sabe parsear dd/mm/yyyy)
const MESES: Record<string, string> = {
  enero: "01", febrero: "02", marzo: "03", abril: "04", mayo: "05", junio: "06",
  julio: "07", agosto: "08", septiembre: "09", setiembre: "09", octubre: "10",
  noviembre: "11", diciembre: "12",
};

function normalizeFecha(fecha: string): string {
  const m = fecha.trim().toLowerCase().match(/^(\d{1,2})\s+([a-záéíóú]+)\.?\s+(\d{2,4})$/);
  if (!m) return fecha;
  const [, day, mesRaw, yearRaw] = m;
  const mes = MESES[mesRaw] ?? MESES[mesRaw.slice(0, 3)];
  if (!mes) return fecha;
  const year = yearRaw.length === 2 ? `20${yearRaw}` : yearRaw;
  return `${day.padStart(2, "0")}/${mes}/${year}`;
}
