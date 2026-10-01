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

export async function importCardAction(
  _prev: ImportActionState | undefined,
  formData: FormData,
): Promise<ImportActionState> {
  const file = formData.get("file") as File | null;
  const accountRef = String(formData.get("accountRef") ?? "");
  const yearRaw = String(formData.get("statementYear") ?? "");

  if (!file || file.size === 0) return { error: "Subí el PDF del resumen." };
  if (!accountRef) return { error: "Indicá a qué tarjeta corresponde." };

  const buffer = Buffer.from(await file.arrayBuffer());
  const statementYear = yearRaw ? Number(yearRaw) : undefined;
  const { parseCardPdf } = await import("@/lib/parsers/card-pdf");
  const parsed = await parseCardPdf(buffer, statementYear);

  if (parsed.rows.length === 0) {
    return {
      error:
        "No se pudo extraer ningún consumo de este PDF. El layout de este resumen no coincide con las reglas actuales — hay que ajustar el parser con este archivo como referencia.",
      warnings: parsed.warnings,
    };
  }

  const saved = await saveImportAndReconcile("card", file.name, accountRef, parsed, {
    issuer: parsed.issuer,
    closingBalance: parsed.closingBalance,
  });

  revalidatePath("/dashboard");
  revalidatePath("/review");
  revalidatePath("/import");

  const balanceNote =
    parsed.closingBalance !== null
      ? ` Total detectado en el resumen: $${parsed.closingBalance.toLocaleString("es-AR")} (sumá los consumos importados para verificar que coincida).`
      : "";

  return {
    success: `Se importaron ${saved.rowCount} consumos de "${accountRef}".${balanceNote} Conciliación: ${saved.reconcile.cardStatementMatches} matches automáticos contra el banco.`,
    warnings: parsed.warnings,
  };
}
