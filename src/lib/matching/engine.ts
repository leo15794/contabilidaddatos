import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { importBatches, matchItems, matches, transactions } from "@/db/schema";
import { jaccardSimilarity } from "./text-similarity";
import { isNonReconcilableBankMovement } from "./exclusions";

export type EngineOptions = {
  /** Ventana de días para considerar dos movimientos "cercanos" en fecha. */
  dateWindowDays?: number;
  /** Tolerancia absoluta en pesos para considerar dos importes "iguales". */
  amountTolerance?: number;
  /** Diferencia porcentual máxima para el match fuzzy (además de la ventana de fecha ampliada). */
  fuzzyAmountTolerancePct?: number;
};

const DEFAULTS: Required<EngineOptions> = {
  dateWindowDays: 5,
  amountTolerance: 0.01,
  fuzzyAmountTolerancePct: 0.02,
};

type Txn = typeof transactions.$inferSelect;

function daysBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24);
}

async function getUnmatchedTransactions(): Promise<Txn[]> {
  // Transacciones que no están en ningún match con estado != 'rejected'.
  const matchedIds = db
    .select({ id: matchItems.transactionId })
    .from(matchItems)
    .innerJoin(matches, eq(matches.id, matchItems.matchId))
    .where(sql`${matches.status} != 'rejected'`);

  return db
    .select()
    .from(transactions)
    .where(notInArray(transactions.id, matchedIds))
    .orderBy(asc(transactions.date));
}

async function createMatch(
  strategy: "exact_1to1" | "card_statement_1toN" | "fuzzy",
  status: "auto" | "pending",
  confidence: number,
  amountDiff: number,
  transactionIds: number[],
  note?: string,
) {
  const [row] = await db
    .insert(matches)
    .values({ strategy, status, confidence, amountDiff: amountDiff.toFixed(2), note })
    .returning({ id: matches.id });

  await db.insert(matchItems).values(
    transactionIds.map((transactionId) => ({ matchId: row.id, transactionId })),
  );

  return row.id;
}

/**
 * Estrategia 1: match exacto 1 a 1 entre dos fuentes distintas, mismo signo,
 * importe casi igual, dentro de la ventana de fechas. Solo se auto-confirma
 * si el candidato es único (sin ambigüedad).
 */
async function runExact1to1(pool: Txn[], opts: Required<EngineOptions>) {
  const used = new Set<number>();
  let created = 0;

  for (let i = 0; i < pool.length; i++) {
    const a = pool[i];
    if (used.has(a.id)) continue;

    const amountA = Number(a.amount);
    const candidates: Txn[] = [];

    for (let j = 0; j < pool.length; j++) {
      if (i === j) continue;
      const b = pool[j];
      if (used.has(b.id)) continue;
      if (b.source === a.source) continue; // tiene que ser de otra fuente
      const amountB = Number(b.amount);

      const sameSign = Math.sign(amountA) === Math.sign(amountB);
      const amountClose = Math.abs(Math.abs(amountA) - Math.abs(amountB)) <= opts.amountTolerance;
      const dateClose = daysBetween(a.date, b.date) <= opts.dateWindowDays;

      if (sameSign && amountClose && dateClose) candidates.push(b);
    }

    if (candidates.length === 1) {
      const b = candidates[0];
      used.add(a.id);
      used.add(b.id);
      await createMatch(
        "exact_1to1",
        "auto",
        95,
        Math.abs(Math.abs(amountA) - Math.abs(Number(b.amount))),
        [a.id, b.id],
      );
      created++;
    }
  }

  return { created, remaining: pool.filter((t) => !used.has(t.id)) };
}

/**
 * Estrategia 2: agrupa los consumos de tarjeta de un mismo lote de importación
 * (= un resumen) y los suma contra un pago bancario único dentro de una
 * ventana de fecha más amplia (el pago del resumen suele ser 10-20 días después
 * del cierre).
 */
async function runCardStatementMatch(pool: Txn[], opts: Required<EngineOptions>) {
  const used = new Set<number>();
  let created = 0;

  const cardRows = pool.filter((t) => t.source === "card");
  const bankRows = pool.filter((t) => t.source === "bank");

  const byBatch = new Map<number, Txn[]>();
  for (const row of cardRows) {
    if (!byBatch.has(row.batchId)) byBatch.set(row.batchId, []);
    byBatch.get(row.batchId)!.push(row);
  }

  for (const [, rows] of byBatch) {
    if (rows.some((r) => used.has(r.id))) continue;
    const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);
    const lastDate = rows.reduce((max, r) => (r.date > max ? r.date : max), rows[0].date);

    const candidates = bankRows.filter((b) => {
      if (used.has(b.id)) return false;
      const amountClose = Math.abs(Math.abs(Number(b.amount)) - Math.abs(total)) <= opts.amountTolerance;
      // ventana más amplia: el pago puede ser hasta 25 días después del último consumo
      const withinWindow = b.date >= lastDate && daysBetween(b.date, lastDate) <= 25;
      return amountClose && withinWindow;
    });

    if (candidates.length === 1) {
      const bank = candidates[0];
      for (const r of rows) used.add(r.id);
      used.add(bank.id);
      await createMatch(
        "card_statement_1toN",
        "auto",
        90,
        Math.abs(Math.abs(Number(bank.amount)) - Math.abs(total)),
        [...rows.map((r) => r.id), bank.id],
        `Resumen de tarjeta (${rows.length} consumos) vs pago bancario`,
      );
      created++;
    }
  }

  return { created, remaining: pool.filter((t) => !used.has(t.id)) };
}

/**
 * Estrategia 3: candidatos fuzzy para revisión manual (nunca se auto-confirman).
 * Compara importe con tolerancia porcentual + similitud de texto entre
 * descripción/contraparte, dentro de una ventana de fecha más amplia.
 */
async function runFuzzySuggestions(pool: Txn[], opts: Required<EngineOptions>) {
  const used = new Set<number>();
  let created = 0;
  const wideWindow = opts.dateWindowDays * 3;

  for (let i = 0; i < pool.length; i++) {
    const a = pool[i];
    if (used.has(a.id)) continue;
    const amountA = Number(a.amount);

    let best: { txn: Txn; score: number; amountDiff: number } | null = null;

    for (let j = 0; j < pool.length; j++) {
      if (i === j) continue;
      const b = pool[j];
      if (used.has(b.id)) continue;
      if (b.source === a.source) continue;
      const amountB = Number(b.amount);
      if (Math.sign(amountA) !== Math.sign(amountB)) continue;

      const pctDiff = Math.abs(Math.abs(amountA) - Math.abs(amountB)) / Math.max(Math.abs(amountA), 0.01);
      if (pctDiff > opts.fuzzyAmountTolerancePct * 5) continue; // hasta 10% de diferencia
      if (daysBetween(a.date, b.date) > wideWindow) continue;

      const textScore = jaccardSimilarity(
        `${a.description} ${a.counterparty ?? ""}`,
        `${b.description} ${b.counterparty ?? ""}`,
      );
      const amountScore = 1 - Math.min(pctDiff / 0.1, 1);
      const score = textScore * 0.6 + amountScore * 0.4;

      if (score > 0.25 && (!best || score > best.score)) {
        best = { txn: b, score, amountDiff: Math.abs(Math.abs(amountA) - Math.abs(amountB)) };
      }
    }

    if (best) {
      used.add(a.id);
      used.add(best.txn.id);
      await createMatch(
        "fuzzy",
        "pending",
        Math.round(best.score * 100),
        best.amountDiff,
        [a.id, best.txn.id],
        "Sugerencia automática — requiere confirmación manual",
      );
      created++;
    }
  }

  return { created, remaining: pool.filter((t) => !used.has(t.id)) };
}

export async function runMatchingEngine(options: EngineOptions = {}) {
  const opts = { ...DEFAULTS, ...options };
  // Movimientos bancarios "internos" (impuestos, comisiones, transferencias
  // entre cuentas propias) nunca deberían conciliar contra una factura o
  // ticket — no son pagos a/de terceros. Se sacan del pool antes de correr
  // cualquiera de las 3 estrategias, así ni se auto-confirman ni aparecen
  // como sugerencia para revisar.
  const pool0 = (await getUnmatchedTransactions()).filter(
    (t) => !isNonReconcilableBankMovement(t),
  );

  const step1 = await runExact1to1(pool0, opts);
  const step2 = await runCardStatementMatch(step1.remaining, opts);
  const step3 = await runFuzzySuggestions(step2.remaining, opts);

  return {
    exactMatches: step1.created,
    cardStatementMatches: step2.created,
    fuzzySuggestions: step3.created,
    stillUnmatched: step3.remaining.length,
  };
}
