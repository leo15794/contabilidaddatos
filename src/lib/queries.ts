import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { importBatches, matchItems, matches, transactions } from "@/db/schema";

export async function getDashboardSummary() {
  const allTxns = await db.select().from(transactions);

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

  const matchedTxnIds = await db
    .select({ id: matchItems.transactionId })
    .from(matchItems)
    .innerJoin(matches, eq(matches.id, matchItems.matchId))
    .where(sql`${matches.status} in ('auto','confirmed','manual')`);

  const confirmedCount = new Set(matchedTxnIds.map((r) => r.id)).size;
  const pendingCount = await db
    .select({ id: matches.id })
    .from(matches)
    .where(eq(matches.status, "pending"));

  const recentBatches = await db
    .select()
    .from(importBatches)
    .orderBy(desc(importBatches.importedAt))
    .limit(10);

  // Tickets (fotos por WhatsApp) sin ningún match, con más de 3 días: probablemente
  // les falta la factura AFIP correspondiente — vale la pena avisar.
  const matchedIdSet = new Set(matchedTxnIds.map((r) => r.id));
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
    pendingReviewCount: pendingCount.length,
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
