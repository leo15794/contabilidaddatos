import { PDFParse } from "pdf-parse";
import { ParseResult, ParsedRow, parseArDate, parseArNumber } from "./types";
import { detectFeeCategory } from "./fee-categories";

/**
 * Parser BEST-EFFORT de resúmenes de tarjeta de crédito en PDF.
 *
 * ⚠️ Los layouts de resumen varían mucho entre bancos/tarjetas (Visa, Master,
 * Amex, y cada banco tiene el suyo). Esto arranca de una heurística genérica:
 * busca líneas de texto con forma "fecha ... descripción ... importe" y separa
 * consumos en pesos/dólares y cuotas cuando puede detectarlas.
 *
 * Está pensado para AJUSTARSE en cuanto tengamos un PDF real de Leo: en ese
 * momento conviene mirar el texto extraído (se guarda completo en `raw`) y
 * afinar las expresiones regulares de abajo, o directamente escribir un
 * adaptador específico para ese emisor (ver `detectIssuer`).
 */

const LINE_RE =
  /^(\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?)\s+(.+?)\s+(-?\$?\s?-?\d{1,3}(?:\.\d{3})*,\d{2})\s*$/;

// Algunas tarjetas listan "01/06" como cuota "1 de 6".
const INSTALLMENT_RE = /(\d{1,2})\s*\/\s*(\d{1,2})\s*$/;

export function detectIssuer(text: string): string | null {
  const lower = text.toLowerCase();
  if (lower.includes("visa")) return "Visa";
  if (lower.includes("mastercard") || lower.includes("master card")) return "Mastercard";
  if (lower.includes("american express") || lower.includes("amex")) return "Amex";
  return null;
}

export async function parseCardPdf(
  fileBuffer: Buffer,
  statementYear?: number,
): Promise<ParseResult & { rawText: string; issuer: string | null; closingBalance: number | null }> {
  const parser = new PDFParse({ data: fileBuffer });
  const result = await parser.getText();
  const text = result.text;
  await parser.destroy();

  const warnings: string[] = [];
  const issuer = detectIssuer(text);
  const rows: ParsedRow[] = [];

  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const year = statementYear ?? new Date().getFullYear();

  for (const line of lines) {
    const match = line.match(LINE_RE);
    if (!match) continue;

    const [, dateStr, descriptionRaw, amountStr] = match;

    // Completa el año si el resumen solo trae dd/mm.
    let normalizedDate = dateStr;
    if (!/\d{4}/.test(dateStr) && (dateStr.match(/[/.-]/g)?.length ?? 0) === 1) {
      normalizedDate = `${dateStr}/${year}`;
    }
    const date = parseArDate(normalizedDate);
    if (!date) continue;

    const amount = -Math.abs(parseArNumber(amountStr)); // consumo de tarjeta = egreso

    const installmentMatch = descriptionRaw.match(INSTALLMENT_RE);
    const description = descriptionRaw.trim();

    rows.push({
      date,
      description,
      amount,
      currency: "ARS",
      // Cargos bancarios conocidos (IVA, comisiones, sellos, etc.) — ver
      // fee-categories.ts. El resto sigue necesitando conciliación normal.
      category: detectFeeCategory(description),
      raw: {
        line,
        installment: installmentMatch
          ? { current: Number(installmentMatch[1]), total: Number(installmentMatch[2]) }
          : null,
      },
    });
  }

  // Intenta encontrar el total del resumen (para poder validar contra la suma de consumos).
  let closingBalance: number | null = null;
  const totalMatch = text.match(
    /(?:total\s*(?:actual|del\s*resumen|a\s*pagar)?)[:\s]+\$?\s?(-?\d{1,3}(?:\.\d{3})*,\d{2})/i,
  );
  if (totalMatch) {
    closingBalance = parseArNumber(totalMatch[1]);
  }

  if (rows.length === 0) {
    warnings.push(
      "No se pudo detectar ningún consumo en el PDF con las reglas actuales. El layout de este resumen probablemente no coincide con la heurística genérica — hay que afinar el parser con este archivo como referencia.",
    );
  }

  return { rows, warnings, rawText: text, issuer, closingBalance };
}
