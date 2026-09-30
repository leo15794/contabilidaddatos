import { db } from "@/db";
import { importBatches, transactions } from "@/db/schema";
import { ParseResult } from "./parsers/types";
import { runMatchingEngine } from "./matching/engine";

export type ImportSource = "bank" | "card" | "afip_issued" | "afip_received";

export async function saveImport(
  source: ImportSource,
  filename: string,
  accountRef: string | null,
  result: ParseResult,
  columnMapping?: Record<string, unknown>,
) {
  const [batch] = await db
    .insert(importBatches)
    .values({
      source,
      filename,
      accountRef: accountRef || null,
      rowCount: result.rows.length,
      columnMapping: columnMapping ?? null,
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
        accountRef: accountRef || null,
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
) {
  const saved = await saveImport(source, filename, accountRef, result, columnMapping);
  const reconcile = await runMatchingEngine();
  return { ...saved, reconcile };
}
