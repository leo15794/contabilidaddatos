"use server";

import { revalidatePath } from "next/cache";
import { parseAfipCsv } from "@/lib/parsers/afip-csv";
import { parseBankCsv, BankColumnMapping } from "@/lib/parsers/bank-csv";
import { saveImportAndReconcile } from "@/lib/import";

// `card-pdf.ts` carga pdf-parse -> pdfjs-dist, que al evaluarse referencia
// `DOMMatrix` (un global de browser que no existe en el runtime Node de
// Vercel). Si se importa en el tope del archivo, ese `ReferenceError` revienta
// TODA acción de este módulo (bank y AFIP incluidas), no solo la de tarjeta.
// Se importa dinámicamente, solo dentro de importCardAction, para que ese
// problema quede aislado a la importación de tarjeta (que ya es best-effort).

export type ImportActionState = {
  error?: string;
  success?: string;
  warnings?: string[];
};

export async function importAfipAction(
  _prev: ImportActionState | undefined,
  formData: FormData,
): Promise<ImportActionState> {
  const file = formData.get("file") as File | null;
  const direction = String(formData.get("direction") ?? "received") as "issued" | "received";

  if (!file || file.size === 0) return { error: "Subí un archivo CSV." };

  const text = await file.text();
  const result = parseAfipCsv(text, direction);

  if (result.rows.length === 0) {
    return { error: "No se pudo leer ningún comprobante del archivo.", warnings: result.warnings };
  }

  const saved = await saveImportAndReconcile(
    direction === "issued" ? "afip_issued" : "afip_received",
    file.name,
    null,
    result,
  );

  revalidatePath("/dashboard");
  revalidatePath("/review");
  revalidatePath("/import");

  return {
    success: `Se importaron ${saved.rowCount} comprobantes ${direction === "issued" ? "emitidos" : "recibidos"}. Conciliación: ${saved.reconcile.exactMatches} matches automáticos, ${saved.reconcile.fuzzySuggestions} sugerencias para revisar.`,
    warnings: result.warnings,
  };
}

export async function importBankAction(
  _prev: ImportActionState | undefined,
  formData: FormData,
): Promise<ImportActionState> {
  const file = formData.get("file") as File | null;
  const accountRef = String(formData.get("accountRef") ?? "");
  const mappingRaw = String(formData.get("mapping") ?? "");

  if (!file || file.size === 0) return { error: "Subí un archivo CSV." };
  if (!accountRef) return { error: "Indicá a qué cuenta/banco corresponde." };

  let mapping: BankColumnMapping;
  try {
    mapping = JSON.parse(mappingRaw);
  } catch {
    return { error: "Falta mapear las columnas del archivo (fecha, descripción, importe)." };
  }
  if (!mapping.dateColumn || !mapping.descriptionColumn || (!mapping.amountColumn && !(mapping.debitColumn && mapping.creditColumn))) {
    return { error: "Falta mapear las columnas del archivo (fecha, descripción, importe)." };
  }

  const text = await file.text();
  const result = parseBankCsv(text, mapping);

  if (result.rows.length === 0) {
    return { error: "No se pudo leer ningún movimiento del archivo.", warnings: result.warnings };
  }

  const saved = await saveImportAndReconcile("bank", file.name, accountRef, result, mapping);

  revalidatePath("/dashboard");
  revalidatePath("/review");
  revalidatePath("/import");

  return {
    success: `Se importaron ${saved.rowCount} movimientos de "${accountRef}". Conciliación: ${saved.reconcile.exactMatches} matches automáticos, ${saved.reconcile.cardStatementMatches} contra resúmenes de tarjeta, ${saved.reconcile.fuzzySuggestions} sugerencias para revisar.`,
    warnings: result.warnings,
  };
}

// Un resumen "Visa Business"/"Negocios XXI" de Macro trae varias tarjetas
// adicionales adentro de un mismo PDF, cada una con su titular. En vez de
// cargar todo bajo la cuenta genérica que Leo escribe en el form, cada
// consumo se guarda con accountRef "<lo que escribió> · <titular>" — así
// queda separado por socio desde ahora, para cuando más adelante se sume lo
// que cada uno tiene disponible para gastar.
function accountRefForCardholder(base: string, cardholderName: string, cardNumber: string): string {
  return `${base} · ${cardholderName} (${cardNumber})`;
}

async function importOneCardFile(
  file: File,
  accountRef: string,
  statementYear: number | undefined,
): Promise<{ ok: true; summary: string; warnings: string[] } | { ok: false; error: string; warnings?: string[] }> {
  const buffer = Buffer.from(await file.arrayBuffer());

  // Primero el parser por texto (rápido, sin costo de API) — sirve para
  // resúmenes que sí traen texto seleccionable adentro del PDF.
  const { parseCardPdf } = await import("@/lib/parsers/card-pdf");
  const textParsed = await parseCardPdf(buffer, statementYear);

  if (textParsed.rows.length > 0) {
    const saved = await saveImportAndReconcile("card", file.name, accountRef, textParsed, {
      issuer: textParsed.issuer,
      closingBalance: textParsed.closingBalance,
    });
    return {
      ok: true,
      summary: `"${file.name}": ${saved.rowCount} consumos de "${accountRef}" (leído por texto). ${saved.reconcile.cardStatementMatches} matches automáticos contra el banco.`,
      warnings: textParsed.warnings,
    };
  }

  // El PDF no tiene texto adentro (es una imagen, típico de un resumen
  // "descargado" que en realidad es una captura) — se lee con Claude.
  const { parseCardStatementWithVision } = await import("@/lib/parsers/card-pdf-vision");
  const vision = await parseCardStatementWithVision(buffer);

  if (vision.rows.length === 0) {
    return {
      ok: false,
      error: `"${file.name}": no se pudo leer ningún consumo (ni por texto ni con el lector visual).`,
      warnings: [...textParsed.warnings, ...vision.warnings],
    };
  }

  // Cada consumo ya viene con el titular/número de tarjeta en `raw` — se
  // sobreescribe el accountRef por fila para que quede separado por socio.
  for (const row of vision.rows) {
    const raw = row.raw as { cardholder?: string; cardNumber?: string; cargoDelResumen?: boolean };
    if (raw.cardholder && raw.cardNumber) {
      row.accountRef = accountRefForCardholder(accountRef, raw.cardholder, raw.cardNumber);
    }
  }

  const saved = await saveImportAndReconcile("card", file.name, accountRef, vision, {
    emisor: vision.extraction?.emisor ?? null,
    cierre: vision.extraction?.cierre ?? null,
    saldoActual: vision.extraction?.saldoActual ?? null,
    leidoConVision: true,
  });

  const reviewNote = vision.needsReview
    ? ` ⚠️ Revisar: ${vision.reviewNotes.join(" ")}`
    : " Los subtotales de cada tarjeta cerraron exacto contra lo extraído.";

  return {
    ok: true,
    summary: `"${file.name}": ${saved.rowCount} consumos de "${accountRef}" (leído con Claude, el PDF no tenía texto). ${saved.reconcile.cardStatementMatches} matches automáticos.${reviewNote}`,
    warnings: [...textParsed.warnings, ...vision.warnings],
  };
}

export async function importCardAction(
  _prev: ImportActionState | undefined,
  formData: FormData,
): Promise<ImportActionState> {
  const files = formData.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
  const accountRef = String(formData.get("accountRef") ?? "");
  const yearRaw = String(formData.get("statementYear") ?? "");

  if (files.length === 0) return { error: "Subí uno o más PDF de resumen." };
  if (!accountRef) return { error: "Indicá a qué tarjeta/cuenta corresponde." };

  const statementYear = yearRaw ? Number(yearRaw) : undefined;

  const successes: string[] = [];
  const errors: string[] = [];
  const allWarnings: string[] = [];

  for (const file of files) {
    const result = await importOneCardFile(file, accountRef, statementYear);
    if (result.ok) {
      successes.push(result.summary);
    } else {
      errors.push(result.error);
    }
    if (result.warnings) allWarnings.push(...result.warnings);
  }

  revalidatePath("/dashboard");
  revalidatePath("/review");
  revalidatePath("/import");

  if (successes.length === 0) {
    return { error: errors.join("\n"), warnings: allWarnings };
  }

  return {
    success: successes.join("\n"),
    warnings: [...errors, ...allWarnings],
  };
}
