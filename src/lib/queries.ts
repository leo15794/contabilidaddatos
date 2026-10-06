import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
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

  // Movimientos categorizados a mano (ej. "Gastos operativos" — comisiones,
  // impuestos y cargos que cobra el banco directo en el resumen, sin ninguna
  // contraparte real para cruzar) no necesitan conciliación — se sacan del
  // denominador del % conciliado para que ese número sea alcanzable al 100%.
  const categorizedTxns = allTxns.filter((t) => t.category);
  const categorizadosCount = categorizedTxns.length;
  const pctDenominator = allTxns.length - categorizadosCount;

  return {
    bySource,
    ingresos,
    egresos,
    totalTxns: allTxns.length,
    conciliadoPct: pctDenominator <= 0 ? 100 : Math.round((confirmedCount / pctDenominator) * 100),
    pendingReviewCount: pendingMatchIdsInRange.size,
    ticketsSinFactura,
    categorizadosCount,
  };
}

/**
 * Movimientos bancarios categorizados a mano (impuestos, comisiones,
 * honorarios, etc. — ver `detectBankFeeCategory` en
 * `src/lib/matching/exclusions.ts`) agrupados por categoría, para mostrar en
 * el Dashboard dónde "desaparecen" esos movimientos que ya no cuentan como
 * "sin conciliar".
 */
export async function getCategorizedBreakdown(range: DateRange = {}) {
  const dateConditions = [sql`${transactions.category} is not null`];
  if (range.from) dateConditions.push(gte(transactions.date, range.from));
  if (range.to) dateConditions.push(lte(transactions.date, range.to));

  const rows = await db
    .select({
      category: transactions.category,
      count: sql<number>`count(*)`,
      total: sql<number>`sum(abs(${transactions.amount}))`,
    })
    .from(transactions)
    .where(and(...dateConditions))
    .groupBy(transactions.category)
    .orderBy(sql`sum(abs(${transactions.amount})) desc`);

  return rows.map((r) => ({
    category: r.category as string,
    count: Number(r.count),
    total: Number(r.total),
  }));
}

/**
 * Detalle de una categoría puntual (ej. "Retiros de efectivo") para la
 * página /categorizados/[categoria]: desglose mes a mes (para ver de un
 * vistazo si un mes tuvo más retiros/comisiones que otro) + la lista
 * completa de movimientos, paginada porque categorías como "Impuestos y
 * comisiones bancarias" tienen miles de filas.
 */
export async function getCategoryDetail(
  category: string,
  { page = 1, pageSize = 50 }: { page?: number; pageSize?: number } = {},
) {
  const whereCategory = eq(transactions.category, category);

  const monthly = await db
    .select({
      month: sql<string>`to_char(${transactions.date}, 'YYYY-MM')`,
      count: sql<number>`count(*)`,
      total: sql<number>`sum(abs(${transactions.amount}))`,
    })
    .from(transactions)
    .where(whereCategory)
    .groupBy(sql`to_char(${transactions.date}, 'YYYY-MM')`)
    .orderBy(sql`to_char(${transactions.date}, 'YYYY-MM') desc`);

  const [{ count: totalCount, total: totalAmount }] = await db
    .select({
      count: sql<number>`count(*)`,
      total: sql<number>`sum(abs(${transactions.amount}))`,
    })
    .from(transactions)
    .where(whereCategory);

  const rows = await db
    .select()
    .from(transactions)
    .where(whereCategory)
    .orderBy(desc(transactions.date))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return {
    monthly: monthly.map((m) => ({ month: m.month, count: Number(m.count), total: Number(m.total) })),
    totalCount: Number(totalCount ?? 0),
    totalAmount: Number(totalAmount ?? 0),
    rows,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(Number(totalCount ?? 0) / pageSize)),
  };
}

const INVESTMENTS_CATEGORY = "Movimientos de fondos / inversiones propias";

/**
 * Desglose de "Movimientos de fondos / inversiones propias" (plazo fijo +
 * fondos comunes de inversión) en colocación/cobro y suscripción/rescate,
 * para la página /inversiones.
 *
 * OJO con lo que esto puede y no puede decir:
 * - Plazo fijo: colocación (sale plata) y cobro al vencimiento (vuelve
 *   capital + interés) son eventos discretos que vemos completos en el
 *   extracto, así que cobros-colocaciones es una ganancia aproximada
 *   razonable. Pero si hay más cobros que colocaciones en los datos, es
 *   porque algunos plazos fijos se constituyeron ANTES del rango de fechas
 *   importado — ese cobro trae capital que no vemos salir en ningún lado, así
 *   que la ganancia real de intereses es probablemente MENOR al número que
 *   se muestra acá (`pfDesbalanceado` marca este caso).
 * - Fondo común de inversión: no se puede calcular ganancia real con esto.
 *   Suscripción/rescate es flujo de caja, no rendimiento — si rescatás menos
 *   de lo que suscribiste es porque todavía tenés plata adentro del fondo
 *   (que vale lo que vale hoy, un dato que no está en los movimientos
 *   bancarios), no porque hayas perdido plata.
 */
export async function getInvestmentBreakdown() {
  const rows = await db
    .select({ description: transactions.description, amount: transactions.amount })
    .from(transactions)
    .where(eq(transactions.category, INVESTMENTS_CATEGORY));

  const acc = {
    pfColocaciones: { count: 0, total: 0 },
    pfCobros: { count: 0, total: 0 },
    fciSuscripciones: { count: 0, total: 0 },
    fciRescates: { count: 0, total: 0 },
    otros: { count: 0, total: 0 },
  };

  for (const r of rows) {
    const amount = Number(r.amount);
    const d = r.description;
    if (/sol\.?\s*resc/i.test(d)) {
      acc.fciRescates.count++;
      acc.fciRescates.total += amount;
    } else if (/liq\.?\s*susc/i.test(d)) {
      acc.fciSuscripciones.count++;
      acc.fciSuscripciones.total += amount;
    } else if (/^cr\s*plazo\s*fijo/i.test(d)) {
      acc.pfCobros.count++;
      acc.pfCobros.total += amount;
    } else if (/db\s*plazo\s*fijo/i.test(d)) {
      acc.pfColocaciones.count++;
      acc.pfColocaciones.total += amount;
    } else {
      acc.otros.count++;
      acc.otros.total += amount;
    }
  }

  const pfGananciaAprox = acc.pfCobros.total + acc.pfColocaciones.total; // colocaciones ya es negativo
  const fciNeto = acc.fciRescates.total + acc.fciSuscripciones.total; // suscripciones ya es negativo

  return {
    plazoFijo: {
      colocaciones: acc.pfColocaciones,
      cobros: acc.pfCobros,
      gananciaAprox: pfGananciaAprox,
      desbalanceado: acc.pfCobros.count !== acc.pfColocaciones.count,
    },
    fci: {
      suscripciones: acc.fciSuscripciones,
      rescates: acc.fciRescates,
      neto: fciNeto,
    },
    otros: acc.otros,
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

  // Los categorizados a mano (ej. "Gastos operativos") no tienen contraparte
  // para cruzar — no tiene sentido que aparezcan acá como "sin match".
  return db
    .select()
    .from(transactions)
    .where(and(sql`${transactions.id} not in (${matchedIds})`, isNull(transactions.category)))
    .orderBy(desc(transactions.date));
}

/**
 * Lo mismo que getUnmatchedTransactions pero agrupado por fuente, para la
 * página /review: en vez de tirar los ~1000 movimientos sin match en una
 * sola lista infinita, mostrar "312 de tarjeta, 305 de AFIP recibidas..." y
 * que cada uno lleve al detalle filtrado (ver getUnmatchedDetail).
 */
export async function getUnmatchedBreakdown() {
  const matchedIds = db
    .select({ id: matchItems.transactionId })
    .from(matchItems)
    .innerJoin(matches, eq(matches.id, matchItems.matchId))
    .where(sql`${matches.status} != 'rejected'`);

  const rows = await db
    .select({
      source: transactions.source,
      count: sql<number>`count(*)`,
      total: sql<number>`sum(abs(${transactions.amount}))`,
    })
    .from(transactions)
    .where(and(sql`${transactions.id} not in (${matchedIds})`, isNull(transactions.category)))
    .groupBy(transactions.source)
    .orderBy(sql`count(*) desc`);

  return rows.map((r) => ({ source: r.source, count: Number(r.count), total: Number(r.total) }));
}

export const UNMATCHED_SOURCES = ["bank", "card", "afip_issued", "afip_received", "ticket"] as const;
export type UnmatchedSource = (typeof UNMATCHED_SOURCES)[number];

/**
 * Detalle de "sin ningún match" para una fuente puntual (ver
 * getUnmatchedBreakdown): desglose mes a mes + lista paginada — misma idea
 * que getCategoryDetail, pero para lo que todavía NO tiene categoría ni
 * match (lo que sí necesita que se le cargue el comprobante/movimiento que
 * le falta, a diferencia de lo categorizado).
 */
export async function getUnmatchedDetail(
  source: UnmatchedSource,
  { page = 1, pageSize = 50 }: { page?: number; pageSize?: number } = {},
) {
  const matchedIds = db
    .select({ id: matchItems.transactionId })
    .from(matchItems)
    .innerJoin(matches, eq(matches.id, matchItems.matchId))
    .where(sql`${matches.status} != 'rejected'`);

  const whereClause = and(
    eq(transactions.source, source),
    isNull(transactions.category),
    sql`${transactions.id} not in (${matchedIds})`,
  );

  const monthly = await db
    .select({
      month: sql<string>`to_char(${transactions.date}, 'YYYY-MM')`,
      count: sql<number>`count(*)`,
      total: sql<number>`sum(abs(${transactions.amount}))`,
    })
    .from(transactions)
    .where(whereClause)
    .groupBy(sql`to_char(${transactions.date}, 'YYYY-MM')`)
    .orderBy(sql`to_char(${transactions.date}, 'YYYY-MM') desc`);

  const [{ count: totalCount, total: totalAmount }] = await db
    .select({
      count: sql<number>`count(*)`,
      total: sql<number>`sum(abs(${transactions.amount}))`,
    })
    .from(transactions)
    .where(whereClause);

  const rows = await db
    .select()
    .from(transactions)
    .where(whereClause)
    .orderBy(desc(transactions.date))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return {
    monthly: monthly.map((m) => ({ month: m.month, count: Number(m.count), total: Number(m.total) })),
    totalCount: Number(totalCount ?? 0),
    totalAmount: Number(totalAmount ?? 0),
    rows,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(Number(totalCount ?? 0) / pageSize)),
  };
}

// --------------------------------------------------------------------------
// Importaciones: listado de todos los archivos subidos (resúmenes de
// tarjeta, CSV de banco, CSV de AFIP) con cuántos de sus movimientos ya
// quedaron conciliados, y el detalle movimiento por movimiento de un lote.
// --------------------------------------------------------------------------

export type BatchStats = {
  total: number;
  conciliados: number;
  pendientes: number;
  sinConciliar: number;
  categorizados: number;
};

const EMPTY_STATS: BatchStats = {
  total: 0,
  conciliados: 0,
  pendientes: 0,
  sinConciliar: 0,
  categorizados: 0,
};

// Si una transacción quedó en más de un match a la vez (ej: una sugerencia
// vieja rechazada y una nueva confirmada), se prioriza el status "más
// resuelto" para decidir en qué balde cae.
const STATUS_PRIORITY: Record<string, number> = {
  confirmed: 3,
  manual: 3,
  auto: 3,
  pending: 2,
  rejected: 1,
};

// Una transacción categorizada a mano (ej. "Gastos operativos") no necesita
// contraparte — eso manda por sobre cualquier estado de match que pudiera
// tener (en la práctica nunca tiene uno, pero por las dudas).
function bucketFor(
  status: string | undefined,
  category: string | null | undefined,
): "conciliados" | "pendientes" | "sinConciliar" | "categorizados" {
  if (category) return "categorizados";
  if (status === "auto" || status === "confirmed" || status === "manual") return "conciliados";
  if (status === "pending") return "pendientes";
  return "sinConciliar";
}

/** Todos los lotes importados (no solo los recientes), con sus stats de conciliación. */
export async function getImportBatchesWithStats() {
  const batches = await db.select().from(importBatches).orderBy(desc(importBatches.importedAt));

  const txns = await db
    .select({ id: transactions.id, batchId: transactions.batchId, category: transactions.category })
    .from(transactions);

  const matchRows = await db
    .select({ transactionId: matchItems.transactionId, status: matches.status })
    .from(matchItems)
    .innerJoin(matches, eq(matches.id, matchItems.matchId));

  const bestStatusByTxnId = new Map<number, string>();
  for (const r of matchRows) {
    const prev = bestStatusByTxnId.get(r.transactionId);
    if (!prev || (STATUS_PRIORITY[r.status] ?? 0) > (STATUS_PRIORITY[prev] ?? 0)) {
      bestStatusByTxnId.set(r.transactionId, r.status);
    }
  }

  const statsByBatch = new Map<number, BatchStats>();
  for (const t of txns) {
    const s = statsByBatch.get(t.batchId) ?? { ...EMPTY_STATS };
    s.total++;
    s[bucketFor(bestStatusByTxnId.get(t.id), t.category)]++;
    statsByBatch.set(t.batchId, s);
  }

  return batches.map((b) => ({ batch: b, stats: statsByBatch.get(b.id) ?? EMPTY_STATS }));
}

export type TransactionWithMatchStatus = {
  txn: typeof transactions.$inferSelect;
  matchStatus: string | null;
};

/** Un lote puntual con todos sus movimientos y el estado de conciliación de cada uno. */
export async function getBatchDetail(batchId: number) {
  const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, batchId)).limit(1);
  if (!batch) return null;

  const txns = await db
    .select()
    .from(transactions)
    .where(eq(transactions.batchId, batchId))
    .orderBy(desc(transactions.date));

  const txnIds = txns.map((t) => t.id);
  const matchRows = txnIds.length
    ? await db
        .select({ transactionId: matchItems.transactionId, status: matches.status })
        .from(matchItems)
        .innerJoin(matches, eq(matches.id, matchItems.matchId))
        .where(inArray(matchItems.transactionId, txnIds))
    : [];

  const bestStatusByTxnId = new Map<number, string>();
  for (const r of matchRows) {
    const prev = bestStatusByTxnId.get(r.transactionId);
    if (!prev || (STATUS_PRIORITY[r.status] ?? 0) > (STATUS_PRIORITY[prev] ?? 0)) {
      bestStatusByTxnId.set(r.transactionId, r.status);
    }
  }

  const rows: TransactionWithMatchStatus[] = txns.map((txn) => ({
    txn,
    matchStatus: bestStatusByTxnId.get(txn.id) ?? null,
  }));

  const stats = { ...EMPTY_STATS };
  for (const r of rows) {
    stats.total++;
    stats[bucketFor(r.matchStatus ?? undefined, r.txn.category)]++;
  }

  return { batch, rows, stats };
}

/** Asigna (o quita, con `category: null`) una categoría manual a un conjunto de movimientos. */
export async function setTransactionsCategory(transactionIds: number[], category: string | null) {
  if (transactionIds.length === 0) return;
  await db
    .update(transactions)
    .set({ category })
    .where(inArray(transactions.id, transactionIds));
}

/**
 * Corrige a mano el importe de un movimiento puntual — para los casos donde
 * la fuente original no trae el número (ej. AFIP no manda "Imp. Total" para
 * comprobantes tipo C de monotributistas: el dato directamente no está en el
 * CSV, no hay nada que parsear). `absoluteAmount` se ingresa siempre en
 * positivo (como figura en el comprobante); el signo lo decide la fuente
 * (emitida = ingreso, recibida = egreso) salvo que sea una nota de crédito,
 * que invierte el signo — mismo criterio que usa el parser de AFIP al
 * importar (ver `src/lib/parsers/afip-csv.ts`).
 */
export async function updateTransactionAmount(transactionId: number, absoluteAmount: number): Promise<void> {
  const [txn] = await db.select().from(transactions).where(eq(transactions.id, transactionId)).limit(1);
  if (!txn) return;

  const isCreditNote = /nota\s*de\s*cr[eé]dito/i.test(txn.description);
  const baseSign =
    txn.source === "afip_issued" ? 1 : txn.source === "afip_received" ? -1 : Math.sign(Number(txn.amount)) || -1;
  const sign = isCreditNote ? -baseSign : baseSign;
  const amount = Math.abs(absoluteAmount) * sign;

  await db
    .update(transactions)
    .set({ amount: amount.toFixed(2) })
    .where(eq(transactions.id, transactionId));
}
