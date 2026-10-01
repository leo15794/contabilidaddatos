import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { importBatches, matchItems, matches, transactions } from "@/db/schema";

export type DateRange = { from?: Date; to?: Date };

export async function getDashboardSummary(range: DateRange = {}) {
  const dateConditions = [];
  if (range.from) dateConditions.push(gte(transactions.date, range.from));
  if (range.to) dateConditions.push(lte(transactions.date, range.to));
  const dateFilter = dateConditions.length > 0 ? and(...dateConditions) : undefined;

  const allTxns = dateFilter
    ? await db.select().from(transactions).where(dateFilter)
    : await db.select().from(transactions);

  const bySource = {
    bank: { count: 0, total: 0 },
    card: { count: 0, total: 0 },
    afip_issued: { count: 0, total: 0 },
    afip_received: { count: 0, total: 0 },
    ticket: { count: 0, total: 0 },
  } as Record<string, { count: number; total: number }>;

  let ingresos = 0;
  let egresos = 0;

  for (const t of allTxns) {
    const amount = Number(t.amount);
    bySource[t.source].count++;
    bySource[t.source].total += amount;
    if (amount >= 0) ingresos += amount;
    else egresos += amount;
  }

  // Nota: estos dos van sin filtrar por fecha (traen matchId también) para
  // poder recortarlos contra `allTxns` (que sí está filtrado) abajo.
  const matchedTxnIds = await db
    .select({ id: matchItems.transactionId })
    .from(matchItems)
    .innerJoin(matches, eq(matches.id, matchItems.matchId))
    .where(sql`${matches.status} in ('auto','confirmed','manual')`);

  const pendingItems = await db
    .select({ matchId: matchItems.matchId, transactionId: matchItems.transactionId })
    .from(matchItems)
    .innerJoin(matches, eq(matches.id, matchItems.matchId))
    .where(eq(matches.status, "pending"));

  const recentBatches = await db
    .select()
    .from(importBatches)
    .orderBy(desc(importBatches.importedAt))
    .limit(10);

  const allTxnIds = new Set(allTxns.map((t) => t.id));

  // % conciliado y pendientes de revisar, recortados al rango de fechas:
  // una transacción/match solo cuenta si cae dentro de `allTxns` (ya filtrado).
  const matchedIdSet = new Set(matchedTxnIds.map((r) => r.id));
  const confirmedCount = allTxns.filter((t) => matchedIdSet.has(t.id)).length;
  const pendingMatchIdsInRange = new Set(
    pendingItems.filter((i) => allTxnIds.has(i.transactionId)).map((i) => i.matchId),
  );

  // Tickets (fotos por WhatsApp) sin ningún match, con más de 3 días: probablemente
  // les falta la factura AFIP correspondiente — vale la pena avisar.
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const ticketsSinFactura = allTxns.filter(
    (t) => t.source === "ticket" && !matchedIdSet.has(t.id) && t.date <= threeDaysAgo,
  ).length;

  return {
    bySource,
    ingresos,
    egresos,
    totalTxns: allTxns.length,
    conciliadoPct: allTxns.length === 0 ? 0 : Math.round((confirmedCount / allTxns.length) * 100),
    pendingReviewCount: pendingMatchIdsInRange.size,
    ticketsSinFactura,
    recentBatches,
  };
}

export async function getPendingMatches() {
  const pending = await db
    .select()
    .from(matches)
    .where(eq(matches.status, "pending"))
    .orderBy(desc(matches.createdAt));

  const result = [];
  for (const m of pending) {
    const items = await db
      .select({ txn: transactions })
      .from(matchItems)
      .innerJoin(transactions, eq(transactions.id, matchItems.transactionId))
      .where(eq(matchItems.matchId, m.id));
    result.push({ match: m, transactions: items.map((i) => i.txn) });
  }
  return result;
}

/** Matches ya resueltos (confirmados a mano, cargados a mano, o auto-confirmados por el motor). */
export async function getConfirmedMatches(limit = 200) {
  const resolved = await db
    .select()
    .from(matches)
    .where(sql`${matches.status} in ('confirmed', 'manual', 'auto')`)
    .orderBy(desc(matches.createdAt))
    .limit(limit);

  const [{ count: totalCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(matches)
    .where(sql`${matches.status} in ('confirmed', 'manual', 'auto')`);

  const result = [];
  for (const m of resolved) {
    const items = await db
      .select({ txn: transactions })
      .from(matchItems)
      .innerJoin(transactions, eq(transactions.id, matchItems.transactionId))
      .where(eq(matchItems.matchId, m.id));
    result.push({ match: m, transactions: items.map((i) => i.txn) });
  }
  return { matches: result, totalCount };
}

export async function getUnmatchedTransactions() {
  const matchedIds = db
    .select({ id: matchItems.transactionId })
    .from(matchItems)
    .innerJoin(matches, eq(matches.id, matchItems.matchId))
    .where(sql`${matches.status} != 'rejected'`);

  return db
    .select()
    .from(transactions)
    .where(sql`${transactions.id} not in (${matchedIds})`)
    .orderBy(desc(transactions.date));
}
