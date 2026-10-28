import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { db } from "@/db";
import { importBatches, transactions } from "@/db/schema";
import { ParseResult } from "./parsers/types";
import { runMatchingEngine } from "./matching/engine";

export type ImportSource = "bank" | "card" | "afip_issued" | "afip_received" | "ticket" | "retention";

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

/**
 * Saca de un archivo los movimientos que ya están cargados, para que volver a
 * subir el mismo CSV (o uno que se solapa con otro, ej. dos extractos del
 * banco con días en común) no duplique todo y arme matches espurios.
 *
 * - AFIP: un comprobante se identifica por fecha + descripción (tipo, punto de
 *   venta-número y razón social). El importe NO entra en la clave porque se
 *   puede corregir a mano después (ver `updateTransactionAmount`).
 * - Banco: no hay número de comprobante, así que la clave es fecha +
 *   descripción + importe, y se cuentan las repeticiones: si el archivo trae
 *   dos movimientos idénticos y en la base ya hay uno, entra solo el segundo.
 * Tarjeta y tickets tienen su propio control de duplicados.
 */
async function dropAlreadyImported(
  source: ImportSource,
  accountRef: string | null,
  rows: ParseResult["rows"],
): Promise<{ rows: ParseResult["rows"]; skipped: number }> {
  if (rows.length === 0 || !(source === "bank" || source === "afip_issued" || source === "afip_received")) {
    return { rows, skipped: 0 };
  }

  const keyOf = (date: Date, description: string, amount: number) =>
    source === "bank"
      ? `${date.toISOString()}|${description}|${amount.toFixed(2)}`
      : `${date.toISOString()}|${description}`;

  const times = rows.map((r) => r.date.getTime());
  const existing = await db
    .select({ date: transactions.date, description: transactions.description, amount: transactions.amount })
    .from(transactions)
    .where(
      and(
        eq(transactions.source, source),
        source === "bank"
          ? accountRef
            ? eq(transactions.accountRef, accountRef)
            : isNull(transactions.accountRef)
          : undefined,
        gte(transactions.date, new Date(Math.min(...times))),
        lte(transactions.date, new Date(Math.max(...times))),
      ),
    );

  const alreadyThere = new Map<string, number>();
  for (const e of existing) {
    const key = keyOf(e.date, e.description, Number(e.amount));
    alreadyThere.set(key, (alreadyThere.get(key) ?? 0) + 1);
  }

  const kept: ParseResult["rows"] = [];
  let skipped = 0;
  for (const row of rows) {
    const key = keyOf(row.date, row.description, Number(row.amount.toFixed(2)));
    const left = alreadyThere.get(key) ?? 0;
    if (left > 0) {
      alreadyThere.set(key, left - 1);
      skipped++;
    } else {
      kept.push(row);
    }
  }

  return { rows: kept, skipped };
}

export async function saveImport(
  source: ImportSource,
  filename: string,
  accountRef: string | null,
  parsed: ParseResult,
  columnMapping?: Record<string, unknown>,
  statementDate?: Date | null,
) {
  const { rows, skipped } = await dropAlreadyImported(source, accountRef, parsed.rows);
  // Todo el archivo ya estaba cargado: no se crea un lote vacío.
  if (skipped > 0 && rows.length === 0) {
    return { batchId: null, rowCount: 0, skipped, warnings: parsed.warnings };
  }
  const result: ParseResult = { ...parsed, rows };

  // El lote y sus movimientos van en una transacción: si falla el insert de
  // las filas no queda un lote vacío (que además, para un ticket, bloquearía
  // el reintento por el índice único de idempotencia).
  const batchId = await db.transaction(async (tx) => {
    const [batch] = await tx
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
      await tx.insert(transactions).values(
        result.rows.map((row) => ({
          batchId: batch.id,
          source,
          date: row.date,
          description: row.description,
          amount: row.amount.toFixed(2),
          currency: row.currency ?? "ARS",
          accountRef: row.accountRef || accountRef || null,
          counterparty: row.counterparty ?? null,
          category: row.category ?? null,
          raw: row.raw,
        })),
      );
    }

    return batch.id;
  });

  return { batchId, rowCount: result.rows.length, skipped, warnings: result.warnings };
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
