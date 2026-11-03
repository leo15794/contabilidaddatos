import { and, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { importBatches, matchItems, matches, transactions } from "@/db/schema";

export type DateRange = { from?: Date; to?: Date };

// Importe "en sentido de la deuda" para sumar en SQL (ver `netAmount` en
// src/lib/amounts.ts): en los comprobantes de AFIP las notas de crédito RESTAN
// (la recibida se da vuelta de signo para que toda factura sume), y en banco,
// tarjeta y tickets se suma el valor absoluto como siempre.
const NET_AMOUNT = sql`case ${transactions.source}::text when 'afip_issued' then ${transactions.amount} when 'afip_received' then -${transactions.amount} else abs(${transactions.amount}) end`;

// "Resuelto" = el movimiento está en algún match auto/confirmado/manual.
// "Pendiente" = está en alguna sugerencia todavía sin revisar. Se calculan en
// la base con EXISTS en vez de traer todos los matches a memoria.
const hasMatchWithStatus = (statuses: SQL) =>
  sql`exists (select 1 from match_items mi inner join matches m on m.id = mi.match_id where mi.transaction_id = ${transactions.id} and m.status in ${statuses})`;
const isResolved = () => hasMatchWithStatus(sql`('auto','confirmed','manual')`);
const isPending = () => hasMatchWithStatus(sql`('pending')`);
const isCategorized = () => sql`(${transactions.category} is not null and ${transactions.category} <> '')`;

export async function getDashboardSummary(range: DateRange = {}) {
  const dateConditions = [];
  if (range.from) dateConditions.push(gte(transactions.date, range.from));
  if (range.to) dateConditions.push(lte(transactions.date, range.to));
  const dateFilter = dateConditions.length > 0 ? and(...dateConditions) : undefined;

  const bySource = {
    bank: { count: 0, total: 0 },
    card: { count: 0, total: 0 },
    afip_issued: { count: 0, total: 0 },
    afip_received: { count: 0, total: 0 },
    ticket: { count: 0, total: 0 },
  } as Record<string, { count: number; total: number }>;

  // Todo el resumen se agrega en la base: antes se traía la tabla completa de
  // movimientos a memoria en cada visita al Dashboard.
  const bySourceRows = await db
    .select({
      source: transactions.source,
      count: sql<number>`count(*)`,
      total: sql<number>`coalesce(sum(${transactions.amount}), 0)`,
      ingresos: sql<number>`coalesce(sum(${transactions.amount}) filter (where ${transactions.amount} >= 0), 0)`,
      egresos: sql<number>`coalesce(sum(${transactions.amount}) filter (where ${transactions.amount} < 0), 0)`,
    })
    .from(transactions)
    .where(dateFilter)
    .groupBy(transactions.source);

  let ingresos = 0;
  let egresos = 0;
  let totalTxns = 0;
  for (const r of bySourceRows) {
    bySource[r.source] = { count: Number(r.count), total: Number(r.total) };
    // Las notas de crédito restan: en las emitidas todo el neto va a ingresos
    // (facturas menos notas) y en las recibidas a egresos (negativas menos las
    // notas, que son positivas). Antes una nota de crédito recibida contaba
    // como un ingreso y una emitida como un egreso.
    if (r.source === "afip_issued") ingresos += Number(r.total);
    else if (r.source === "afip_received") egresos += Number(r.total);
    else {
      ingresos += Number(r.ingresos);
      egresos += Number(r.egresos);
    }
    totalTxns += Number(r.count);
  }

  // Tickets (fotos por WhatsApp) sin ningún match, con más de 3 días: probablemente
  // les falta la factura AFIP correspondiente — vale la pena avisar.
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

  const [counts] = await db
    .select({
      confirmed: sql<number>`count(*) filter (where ${isResolved()})`,
      categorized: sql<number>`count(*) filter (where ${isCategorized()})`,
      ticketsSinFactura: sql<number>`count(*) filter (where ${transactions.source} = 'ticket' and not ${isResolved()} and ${transactions.date} <= ${threeDaysAgo}::timestamp)`,
    })
    .from(transactions)
    .where(dateFilter);

  // Sugerencias pendientes de revisar: matches distintos con al menos un
  // movimiento dentro del rango de fechas.
  const [pending] = await db
    .select({ count: sql<number>`count(distinct ${matchItems.matchId})` })
    .from(matchItems)
    .innerJoin(matches, eq(matches.id, matchItems.matchId))
    .innerJoin(transactions, eq(transactions.id, matchItems.transactionId))
    .where(and(eq(matches.status, "pending"), dateFilter));

  // Movimientos categorizados a mano (ej. "Gastos operativos" — comisiones,
  // impuestos y cargos que cobra el banco directo en el resumen, sin ninguna
  // contraparte real para cruzar) no necesitan conciliación — se sacan del
  // denominador del % conciliado para que ese número sea alcanzable al 100%.
  const confirmedCount = Number(counts.confirmed);
  const categorizadosCount = Number(counts.categorized);
  const pctDenominator = totalTxns - categorizadosCount;

  return {
    bySource,
    ingresos,
    egresos,
    totalTxns,
    conciliadoPct: pctDenominator <= 0 ? 100 : Math.round((confirmedCount / pctDenominator) * 100),
    pendingReviewCount: Number(pending.count),
    ticketsSinFactura: Number(counts.ticketsSinFactura),
    categorizadosCount,
    resolvedCount: confirmedCount,
    pctDenominator,
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

/** Trae los movimientos de varios matches en UNA query (antes era una query por match). */
async function withTransactions(matchRows: (typeof matches.$inferSelect)[]) {
  if (matchRows.length === 0) return [];

  const items = await db
    .select({ matchId: matchItems.matchId, txn: transactions })
    .from(matchItems)
    .innerJoin(transactions, eq(transactions.id, matchItems.transactionId))
    .where(inArray(matchItems.matchId, matchRows.map((m) => m.id)));

  const byMatch = new Map<number, (typeof transactions.$inferSelect)[]>();
  for (const i of items) {
    const list = byMatch.get(i.matchId);
    if (list) list.push(i.txn);
    else byMatch.set(i.matchId, [i.txn]);
  }

  return matchRows.map((m) => ({ match: m, transactions: byMatch.get(m.id) ?? [] }));
}

export async function getPendingMatches() {
  const pending = await db
    .select()
    .from(matches)
    .where(eq(matches.status, "pending"))
    .orderBy(desc(matches.createdAt));

  return withTransactions(pending);
}

/**
 * TODOS los cruces resueltos con sus movimientos, para agruparlos por
 * proveedor/cliente y buscar en /conciliados (son unos pocos miles de filas:
 * se agrupan y filtran en memoria, ver `src/lib/match-groups.ts`).
 */
export async function getAllResolvedMatches() {
  const resolved = await db
    .select()
    .from(matches)
    .where(sql`${matches.status} in ('confirmed', 'manual', 'auto')`)
    .orderBy(desc(matches.createdAt));
  return withTransactions(resolved);
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
      total: sql<number>`sum(${NET_AMOUNT})`,
    })
    .from(transactions)
    .where(and(sql`${transactions.id} not in (${matchedIds})`, isNull(transactions.category)))
    .groupBy(transactions.source)
    .orderBy(sql`count(*) desc`);

  return rows.map((r) => ({ source: r.source, count: Number(r.count), total: Number(r.total) }));
}

export const UNMATCHED_SOURCES = ["bank", "card", "afip_issued", "afip_received", "ticket", "retention", "cash"] as const;
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
      total: sql<number>`sum(${NET_AMOUNT})`,
    })
    .from(transactions)
    .where(whereClause)
    .groupBy(sql`to_char(${transactions.date}, 'YYYY-MM')`)
    .orderBy(sql`to_char(${transactions.date}, 'YYYY-MM') desc`);

  const [{ count: totalCount, total: totalAmount }] = await db
    .select({
      count: sql<number>`count(*)`,
      total: sql<number>`sum(${NET_AMOUNT})`,
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

export type ManualSearchRow = {
  id: number;
  source: string;
  date: string;
  description: string;
  counterparty: string | null;
  accountRef: string | null;
  amount: number;
  category: string | null;
  /** Está en una sugerencia sin revisar: hay que rechazarla antes de unirlo a mano. */
  inSuggestion: boolean;
};

/**
 * Buscador para unir a mano: facturas y pagos de TODAS las fuentes que no
 * estén conciliados, por texto (descripción, proveedor, CUIT, cuenta) y/o por
 * importe con un margen. A diferencia de "sin conciliar" también trae los
 * categorizados ("Pendientes de pago", y transferencias mal marcadas como
 * cuentas propias que en realidad le pagaron a un tercero, como las de
 * Córdoba y Fontal) y los que están en una sugerencia pendiente.
 */
export async function searchForManualMatch({
  text,
  amount,
  margin,
  side,
  limit = 100,
}: {
  text?: string;
  amount?: number;
  /** Un solo lado del cruce: comprobantes de AFIP o movimientos de plata. */
  side?: "comprobantes" | "pagos";
  /** Fracción del importe (0.01 = ±1 %); 0 = exacto (±1 peso). */
  margin?: number;
  limit?: number;
}): Promise<ManualSearchRow[]> {
  const conditions: SQL[] = [sql`not ${isResolved()}`];

  for (const word of (text ?? "").trim().split(/\s+/).filter(Boolean)) {
    const like = `%${word}%`;
    conditions.push(
      sql`(${transactions.description} ilike ${like} or coalesce(${transactions.counterparty}, '') ilike ${like} or coalesce(${transactions.accountRef}, '') ilike ${like})`,
    );
  }
  if (amount !== undefined && amount > 0) {
    const delta = Math.max(1, amount * (margin ?? 0));
    conditions.push(sql`abs(${transactions.amount}) between ${amount - delta} and ${amount + delta}`);
  }
  if (conditions.length === 1) return [];
  if (side) {
    const docs = sql`${transactions.source} in ('afip_issued', 'afip_received')`;
    conditions.push(side === "comprobantes" ? docs : sql`not ${docs}`);
  }

  const rows = await db
    .select({
      id: transactions.id,
      source: transactions.source,
      date: transactions.date,
      description: transactions.description,
      counterparty: transactions.counterparty,
      accountRef: transactions.accountRef,
      amount: transactions.amount,
      category: transactions.category,
      inSuggestion: isPending().mapWith(Boolean),
    })
    .from(transactions)
    .where(and(...conditions))
    .orderBy(
      amount !== undefined && amount > 0 ? sql`abs(abs(${transactions.amount}) - ${amount})` : desc(transactions.date),
      desc(transactions.date),
    )
    .limit(limit);

  return rows.map((r) => ({ ...r, date: r.date.toISOString(), amount: Number(r.amount) }));
}

/**
 * TODOS los movimientos sin match de una fuente (sin paginar), para agruparlos
 * por proveedor/comercio y exportarlos. Mismo criterio que `getUnmatchedDetail`.
 * Son cientos por fuente, así que se agrupan en memoria (ver
 * `src/lib/unmatched-groups.ts`) en vez de duplicar esa lógica en SQL.
 */
export async function getUnmatchedAll(source: UnmatchedSource) {
  const matchedIds = db
    .select({ id: matchItems.transactionId })
    .from(matchItems)
    .innerJoin(matches, eq(matches.id, matchItems.matchId))
    .where(sql`${matches.status} != 'rejected'`);

  return db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.source, source),
        isNull(transactions.category),
        sql`${transactions.id} not in (${matchedIds})`,
      ),
    )
    .orderBy(desc(transactions.date));
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

  // Mismos baldes que `bucketFor` (categorizado > resuelto > pendiente > sin
  // conciliar), contados en la base por lote en vez de traer todos los
  // movimientos y todos los matches a memoria.
  const rows = await db
    .select({
      batchId: transactions.batchId,
      total: sql<number>`count(*)`,
      categorizados: sql<number>`count(*) filter (where ${isCategorized()})`,
      conciliados: sql<number>`count(*) filter (where not ${isCategorized()} and ${isResolved()})`,
      pendientes: sql<number>`count(*) filter (where not ${isCategorized()} and not ${isResolved()} and ${isPending()})`,
    })
    .from(transactions)
    .groupBy(transactions.batchId);

  const statsByBatch = new Map<number, BatchStats>();
  for (const r of rows) {
    const total = Number(r.total);
    const categorizados = Number(r.categorizados);
    const conciliados = Number(r.conciliados);
    const pendientes = Number(r.pendientes);
    statsByBatch.set(r.batchId, {
      total,
      categorizados,
      conciliados,
      pendientes,
      sinConciliar: total - categorizados - conciliados - pendientes,
    });
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

// --------------------------------------------------------------------------
// Retiros de efectivo de la empresa (cajero, caja de ahorro) y lo que se pagó
// en mano con esa plata: cada pago en efectivo cargado desde "Pagada en
// efectivo" guarda en `raw.retiroId` de qué retiro salió.
// --------------------------------------------------------------------------

/** Un retiro real de plata del banco; el "IDCB ... EXTRAC EFVO" es el impuesto sobre el retiro, no plata. */
const IS_WITHDRAWAL = sql`${transactions.source} = 'bank' and ${transactions.amount} < 0
  and ${transactions.category} = 'Retiros de efectivo'
  and (${transactions.description} ilike 'RETIRO%' or ${transactions.description} ilike 'EXTRACCION%')`;

export type CashWithdrawal = {
  id: number;
  date: string;
  description: string;
  accountRef: string | null;
  amount: number;
  /** Lo ya justificado con facturas pagadas en efectivo (solo cruces vigentes). */
  used: number;
  available: number;
};

export async function getCashWithdrawals(): Promise<CashWithdrawal[]> {
  const rows = await db
    .select({
      id: transactions.id,
      date: transactions.date,
      description: transactions.description,
      accountRef: transactions.accountRef,
      amount: transactions.amount,
    })
    .from(transactions)
    .where(IS_WITHDRAWAL)
    .orderBy(desc(transactions.date));

  // Aparte y no como subconsulta: adentro de una subconsulta sobre la misma
  // tabla, la columna del retiro se resolvía contra el pago y no sumaba nada.
  const usedRows = await db.execute<{ retiro_id: string; used: string }>(sql`
    select c.raw->>'retiroId' retiro_id, sum(abs(c.amount)) used from transactions c
    where c.source = 'cash' and c.raw->>'retiroId' is not null
      and exists (select 1 from match_items mi join matches m on m.id = mi.match_id
                  where mi.transaction_id = c.id and m.status in ('auto', 'confirmed', 'manual'))
    group by 1`);
  const usedBy = new Map(usedRows.map((u) => [Number(u.retiro_id), Number(u.used)]));

  return rows.map((r) => {
    const amount = Math.abs(Number(r.amount));
    const used = usedBy.get(r.id) ?? 0;
    return {
      id: r.id,
      date: r.date.toISOString(),
      description: r.description,
      accountRef: r.accountRef,
      amount,
      used,
      available: Math.round((amount - used) * 100) / 100,
    };
  });
}

export type WithdrawalPayment = {
  retiroId: number;
  cashId: number;
  date: Date;
  amount: number;
  quien: string | null;
  matchId: number;
  documents: { description: string; amount: number }[];
};

/** Los pagos en efectivo hechos con plata de cada retiro, con las facturas que cubren. */
export async function getWithdrawalPayments(): Promise<WithdrawalPayment[]> {
  const rows = await db.execute<{
    retiro_id: string;
    cash_id: number;
    date: Date;
    amount: string;
    quien: string | null;
    match_id: number;
    doc_description: string | null;
    doc_amount: string | null;
  }>(sql`
    select c.raw->>'retiroId' retiro_id, c.id cash_id, c.date, c.amount, c.raw->>'quien' quien, m.id match_id,
           d.description doc_description, d.amount doc_amount
    from transactions c
    join match_items mi on mi.transaction_id = c.id
    join matches m on m.id = mi.match_id and m.status in ('auto', 'confirmed', 'manual')
    left join match_items di on di.match_id = m.id and di.transaction_id <> c.id
    left join transactions d on d.id = di.transaction_id
    where c.source = 'cash' and c.raw->>'retiroId' is not null
    order by c.date desc, c.id`);

  const byCash = new Map<number, WithdrawalPayment>();
  for (const r of rows) {
    let p = byCash.get(r.cash_id);
    if (!p) {
      p = {
        retiroId: Number(r.retiro_id),
        cashId: r.cash_id,
        date: new Date(r.date),
        amount: Math.abs(Number(r.amount)),
        quien: r.quien,
        matchId: r.match_id,
        documents: [],
      };
      byCash.set(r.cash_id, p);
    }
    if (r.doc_description) p.documents.push({ description: r.doc_description, amount: Number(r.doc_amount) });
  }
  return [...byCash.values()];
}
