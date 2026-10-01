import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { importBatches, transactions } from "@/db/schema";
import { ParseResult } from "./parsers/types";
import { runMatchingEngine } from "./matching/engine";

export type ImportSource = "bank" | "card" | "afip_issued" | "afip_received" | "ticket";

export type DuplicateImportInfo = {
  batchId: number;
  filename: string;
  importedAt: Date;
};

/**
 * Busca si ya existe un resumen de tarjeta cargado para la misma cuenta y la
 * misma fecha de resumen (no de carga). Existe porque un mismo resumen puede
 * subirse dos veces con nombres de archivo distintos sin que se note a
 * simple vista (pasó de verdad: "descarga.pdf" y "descarga (2).pdf" eran el
 * mismo resumen) — el nombre del archivo solo no alcanza para detectarlo.
 */
export async function findDuplicateCardStatement(
  accountRef: string | null,
  statementDate: Date | null,
): Promise<DuplicateImportInfo | null> {
  if (!accountRef || !statementDate) return null;

  const existing = await db
    .select({
      batchId: importBatches.id,
      filename: importBatches.filename,
      importedAt: importBatches.importedAt,
    })
    .from(importBatches)
    .where(
      and(
        eq(importBatches.source, "card"),
        eq(importBatches.accountRef, accountRef),
        eq(importBatches.statementDate, statementDate),
      ),
    )
    .limit(1);

  return existing[0] ?? null;
}

export async function saveImport(
  source: ImportSource,
  filename: string,
  accountRef: string | null,
  result: ParseResult,
  columnMapping?: Record<string, unknown>,
  statementDate?: Date | null,
) {
  const [batch] = await db
    .insert(importBatches)
    .values({
      source,
      filename,
      accountRef: accountRef || null,
      rowCount: result.rows.length,
      columnMapping: columnMapping ?? null,
      statementDate: statementDate ?? null,
    })
    .returning({ id: importBatches.id });

  if (result.rows.length > 0) {
    await db.insert(transactions).values(
      result.rows.map((row) => ({
        batchId: batch.id,
        source,
        date: row.date,
        description: row.description,
        amount: row.amount.toFixed(2),
        currency: row.currency ?? "ARS",
        accountRef: row.accountRef || accountRef || null,
        counterparty: row.counterparty ?? null,
        raw: row.raw,
      })),
    );
  }

  return { batchId: batch.id, rowCount: result.rows.length, warnings: result.warnings };
}

/** Corre el motor de conciliación después de cada importación, para tender a la conciliación automática. */
export async function saveImportAndReconcile(
  source: ImportSource,
  filename: string,
  accountRef: string | null,
  result: ParseResult,
  columnMapping?: Record<string, unknown>,
  statementDate?: Date | null,
) {
  const saved = await saveImport(source, filename, accountRef, result, columnMapping, statementDate);
  const reconcile = await runMatchingEngine();
  return { ...saved, reconcile };
}
