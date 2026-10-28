import { and, eq, inArray, max, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { importBatches, matchItems, matches, transactions } from "@/db/schema";
import { jaccardSimilarity } from "./text-similarity";
import { isNonReconcilableBankMovement } from "./exclusions";
import { extractCuits } from "./cuit";
import { PENDING_PAYMENT_CATEGORY, releasePendingPaymentCategory } from "@/lib/categories";
import { runCreditNotes } from "./credit-notes";
import { runCuitGroups } from "./cuit-groups";
import { runPaymentGroups } from "./payment-groups";
import { runSplitPayments } from "./split-payments";
import { runCardNameMatches } from "./card-name";
import { runInstallments } from "./installments";
import { runPartialCardPayments } from "./partial-card";
import { runCardMultiInvoice } from "./card-multi";
import { runRetentions } from "./retentions";
import { runBankWideWindow, runCuitExactWide, runRoundExtra } from "./bank-invoice";
import { bankNamesAnotherParty } from "./name-guard";
import { pairKey, type MatchSpec, type RejectedPairs, type StepResult, type Txn } from "./types";

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

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Un movimiento de pago (banco/tarjeta) solo puede conciliar contra un
// justificativo (factura AFIP o ticket), nunca contra otro movimiento de
// pago ni —el bug que reportó Leo— una factura emitida contra una recibida:
// son dos comprobantes propios, no un pago real cruzando con un comprobante.
// "cash": gastos que pagó un socio en efectivo (hoja "Gastos Socios"), son el pago de su factura.
const MOVEMENT_SOURCES = new Set(["bank", "card", "cash"]);
const JUSTIFICATION_SOURCES = new Set(["afip_issued", "afip_received", "ticket"]);

function canSourcesMatch(a: string, b: string): boolean {
  return (
    (MOVEMENT_SOURCES.has(a) && JUSTIFICATION_SOURCES.has(b)) ||
    (MOVEMENT_SOURCES.has(b) && JUSTIFICATION_SOURCES.has(a))
  );
}

// Un consumo de tarjeta y la factura recibida de ese mismo gasto se emiten el
// mismo día o a los pocos días: si pasaron más, lo normal es que la factura
// todavía no esté cargada, no que sea otra. Con la ventana general (5 días, y
// hasta 15 en el fuzzy) el motor sugería facturas de otro proveedor solo
// porque el importe era parecido (ej. APPYPF contra SANCHEZ DI MARE, 6 días
// de diferencia y ninguna palabra en común). Vale solo para tarjeta contra
// facturas recibidas: las transferencias del banco sí se pagan semanas después.
const CARD_INVOICE_MAX_DAYS = 2;

// Y por la misma razón, el importe: el total de una factura de estación de
// servicio se arma sumando neto + impuestos y casi nunca coincide al centavo con
// el voucher de la tarjeta (en la planilla de Leo, 39 de 43 pares correctos
// difieren entre $0,01 y $0,75). Con la tolerancia de 1 centavo esos pares
// quedaban como sugerencias en vez de conciliarse solos.
const CARD_INVOICE_AMOUNT_TOLERANCE = 1;

// El efectivo se anota en la planilla con el total del ticket, igual que el
// voucher de la tarjeta: mismo margen de importe y de días contra la factura.
const SAME_DAY_PAYMENT_SOURCES = new Set(["card", "cash"]);

function isCardVsInvoice(sourceA: string, sourceB: string): boolean {
  return (
    (SAME_DAY_PAYMENT_SOURCES.has(sourceA) && sourceB === "afip_received") ||
    (sourceA === "afip_received" && SAME_DAY_PAYMENT_SOURCES.has(sourceB))
  );
}

function maxDaysBetween(sourceA: string, sourceB: string, fallback: number): number {
  return isCardVsInvoice(sourceA, sourceB) ? Math.min(CARD_INVOICE_MAX_DAYS, fallback) : fallback;
}

function exactAmountTolerance(sourceA: string, sourceB: string, base: number): number {
  return isCardVsInvoice(sourceA, sourceB) ? Math.max(base, CARD_INVOICE_AMOUNT_TOLERANCE) : base;
}

// Una transferencia puede pagar una factura hasta un mes después (la tarjeta no): para las
// sugerencias fuzzy el banco contra factura mira hasta FUZZY_BANK_INVOICE_DAYS.
const FUZZY_BANK_INVOICE_DAYS = 30;

function fuzzyMaxDays(sourceA: string, sourceB: string, fallback: number): number {
  const bankVsInvoice =
    (sourceA === "bank" && sourceB.startsWith("afip")) || (sourceB === "bank" && sourceA.startsWith("afip"));
  return bankVsInvoice ? Math.max(fallback, FUZZY_BANK_INVOICE_DAYS) : maxDaysBetween(sourceA, sourceB, fallback);
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24);
}

// Candado de Postgres para que dos corridas del motor a la vez (ej. un import
// y un ticket de WhatsApp llegando juntos, posiblemente en instancias
// distintas de Vercel) no armen matches duplicados sobre los mismos movimientos.
const ENGINE_LOCK_ID = 727001;

async function getUnmatchedTransactions(tx: Tx): Promise<{ pool: Txn[]; statementPaidCardIds: Set<number> }> {
  // Transacciones que no están en ningún match con estado != 'rejected'...
  const matchedIds = tx
    .select({ id: matchItems.transactionId })
    .from(matchItems)
    .innerJoin(matches, eq(matches.id, matchItems.matchId))
    .where(sql`${matches.status} != 'rejected'`);

  // ...más los consumos de tarjeta que solo están en el cruce del resumen contra
  // el débito del banco: eso prueba que se pagaron, pero todavía les falta la
  // factura. Antes quedaban afuera para siempre y su factura, sin conciliar.
  const otherThanStatement = tx
    .select({ id: matchItems.transactionId })
    .from(matchItems)
    .innerJoin(matches, eq(matches.id, matchItems.matchId))
    .where(sql`${matches.status} != 'rejected' and ${matches.strategy} != 'card_statement_1toN'`);
  const statementPaid = await tx
    .select()
    .from(transactions)
    .where(and(eq(transactions.source, "card"), inArray(transactions.id, matchedIds), notInArray(transactions.id, otherThanStatement)));

  const free = await tx.select().from(transactions).where(notInArray(transactions.id, matchedIds));
  const pool = [...free, ...statementPaid].sort((a, b) => a.date.getTime() - b.date.getTime() || a.id - b.id);
  return { pool, statementPaidCardIds: new Set(statementPaid.map((t) => t.id)) };
}

async function getRejectedPairs(tx: Tx): Promise<RejectedPairs> {
  const rows = await tx
    .select({ matchId: matchItems.matchId, transactionId: matchItems.transactionId })
    .from(matchItems)
    .innerJoin(matches, eq(matches.id, matchItems.matchId))
    .where(eq(matches.status, "rejected"));

  const byMatch = new Map<number, number[]>();
  for (const r of rows) {
    const ids = byMatch.get(r.matchId);
    if (ids) ids.push(r.transactionId);
    else byMatch.set(r.matchId, [r.transactionId]);
  }

  const pairs: RejectedPairs = new Set();
  for (const ids of byMatch.values()) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) pairs.add(pairKey(ids[i], ids[j]));
    }
  }
  return pairs;
}

// Los inserts van en tandas para no pasarse del máximo de parámetros de una
// query de Postgres (65535).
const MATCH_INSERT_CHUNK = 500;
const ITEM_INSERT_CHUNK = 1000;

async function persistMatches(tx: Tx, specs: MatchSpec[]) {
  if (specs.length === 0) return;

  const matchIds: number[] = [];
  for (let i = 0; i < specs.length; i += MATCH_INSERT_CHUNK) {
    const chunk = specs.slice(i, i + MATCH_INSERT_CHUNK);
    const rows = await tx
      .insert(matches)
      .values(
        chunk.map((s) => ({
          strategy: s.strategy,
          status: s.status,
          confidence: s.confidence,
          amountDiff: s.amountDiff.toFixed(2),
          note: s.note,
        })),
      )
      .returning({ id: matches.id });
    // INSERT ... VALUES ... RETURNING devuelve las filas en el orden de los VALUES.
    for (const r of rows) matchIds.push(r.id);
  }

  const items = specs.flatMap((s, idx) =>
    s.transactionIds.map((transactionId) => ({ matchId: matchIds[idx], transactionId })),
  );
  for (let i = 0; i < items.length; i += ITEM_INSERT_CHUNK) {
    await tx.insert(matchItems).values(items.slice(i, i + ITEM_INSERT_CHUNK));
  }
}

/**
 * Estrategia 1: match exacto 1 a 1 entre dos fuentes distintas, mismo signo,
 * importe casi igual, dentro de la ventana de fechas. Solo se auto-confirma
 * si el candidato es único (sin ambigüedad).
 *
 * Caso especial: si un pago tiene como únicos candidatos una factura AFIP y
 * un ticket, son casi seguro el MISMO gasto documentado dos veces (la foto
 * del ticket y la factura que llega después a AFIP) — se unen los tres en un
 * solo match en vez de dejar el pago ambiguo y la otra pata huérfana.
 *
 * Los candidatos se buscan por balde de importe (en centavos) en vez de
 * recorrer todo el pool contra todo el pool.
 */
function runExact1to1(pool: Txn[], opts: Required<EngineOptions>, rejected: RejectedPairs): StepResult {
  const used = new Set<number>();
  const specs: MatchSpec[] = [];

  const toCents = (t: Txn) => Math.round(Math.abs(Number(t.amount)) * 100);
  const byCents = new Map<number, Txn[]>();
  for (const t of pool) {
    const key = toCents(t);
    const bucket = byCents.get(key);
    if (bucket) bucket.push(t);
    else byCents.set(key, [t]);
  }
  // Hasta dónde mirar baldes vecinos: cubre también la tolerancia mayor de tarjeta contra factura recibida.
  const spanCents = Math.ceil(Math.max(opts.amountTolerance, CARD_INVOICE_AMOUNT_TOLERANCE) * 100) + 1;

  // Primero los pagos (banco/tarjeta), así un pago con factura + ticket se
  // resuelve como match de tres antes de que la factura lo "robe" sola.
  const ordered = [
    ...pool.filter((t) => MOVEMENT_SOURCES.has(t.source)),
    ...pool.filter((t) => !MOVEMENT_SOURCES.has(t.source)),
  ];

  for (const a of ordered) {
    if (used.has(a.id)) continue;

    const amountA = Number(a.amount);
    const centsA = toCents(a);
    const candidates: Txn[] = [];

    for (let k = centsA - spanCents; k <= centsA + spanCents; k++) {
      for (const b of byCents.get(k) ?? []) {
        if (b.id === a.id || used.has(b.id)) continue;
        if (b.source === a.source) continue; // tiene que ser de otra fuente
        if (!canSourcesMatch(a.source, b.source)) continue; // y tiene que ser pago<->justificativo, no dos comprobantes propios
        if (bankNamesAnotherParty(a.source === "bank" ? a : b, a.source === "bank" ? b : a)) continue; // pago a Google no es de la factura de otro
        if (rejected.has(pairKey(a.id, b.id))) continue; // ya lo rechazaron a mano: no volver a proponerlo

        const amountB = Number(b.amount);

        const sameSign = Math.sign(amountA) === Math.sign(amountB);
        const amountClose =
          Math.abs(Math.abs(amountA) - Math.abs(amountB)) <= exactAmountTolerance(a.source, b.source, opts.amountTolerance);
        const dateClose = daysBetween(a.date, b.date) <= maxDaysBetween(a.source, b.source, opts.dateWindowDays);

        if (sameSign && amountClose && dateClose) candidates.push(b);
      }
    }

    if (candidates.length === 1) {
      const b = candidates[0];
      used.add(a.id);
      used.add(b.id);
      specs.push({
        strategy: "exact_1to1",
        status: "auto",
        confidence: 95,
        amountDiff: Math.abs(Math.abs(amountA) - Math.abs(Number(b.amount))),
        transactionIds: [a.id, b.id],
      });
      continue;
    }

    if (candidates.length === 2 && MOVEMENT_SOURCES.has(a.source)) {
      const ticket = candidates.find((c) => c.source === "ticket");
      const invoice = candidates.find((c) => c.source !== "ticket");
      if (ticket && invoice) {
        used.add(a.id);
        used.add(ticket.id);
        used.add(invoice.id);
        specs.push({
          strategy: "exact_1to1",
          status: "auto",
          confidence: 90,
          amountDiff: Math.abs(Math.abs(amountA) - Math.abs(Number(invoice.amount))),
          transactionIds: [a.id, invoice.id, ticket.id],
          note: "Pago con factura AFIP y ticket del mismo gasto — los tres quedan unidos.",
        });
      }
    }
  }

  return { specs, remaining: pool.filter((t) => !used.has(t.id)) };
}

/**
 * Estrategia 2: un resumen de tarjeta (= un lote de importación) contra el
 * pago único que el banco debita ("DB TARJETA DE CREDITO VISA").
 *
 * El pago cubre el resumen ENTERO, no solo los consumos que siguen libres: los
 * cargos que ya se categorizaron (impuestos, comisiones) y los consumos que ya
 * se conciliaron aparte con un ticket o una factura también están adentro. Por
 * eso el total a comparar sale de TODAS las filas del lote (o, si el lote
 * guardó el saldo del resumen, de ese saldo, que es el número que el banco
 * realmente debita). Antes se sumaban solo las filas libres y el pago no
 * cerraba nunca. El match une el pago con las filas que todavía están libres.
 */
// Diferencia máxima (sobre el total del resumen) para sugerir un pago que no cierra exacto.
const CARD_NEAR_TOTAL_PCT = 0.01;
// Los resúmenes se leen fila por fila: el total puede diferir en centavos de redondeo del saldo impreso.
const CARD_TOTAL_TOLERANCE = 1;
// El pago suele debitarse 10-20 días después del último consumo; se deja margen de 2 días antes por si el cierre figura corrido.
const CARD_PAYMENT_DAYS_BEFORE = 2;
const CARD_PAYMENT_DAYS_AFTER = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type CardBatchInfo = {
  /** Suma con signo de TODAS las filas del lote, libres o no. */
  total: number;
  rowCount: number;
  /** Saldo del resumen guardado al importar (en positivo), si el lector lo encontró. */
  closing: number | null;
  /** Fecha del último consumo del lote entero. */
  lastDate: Date;
};

async function getCardBatchInfo(tx: Tx, batchIds: number[]): Promise<Map<number, CardBatchInfo>> {
  const info = new Map<number, CardBatchInfo>();
  if (batchIds.length === 0) return info;

  const totals = await tx
    .select({
      batchId: transactions.batchId,
      total: sql<string>`sum(${transactions.amount})`,
      rowCount: sql<string>`count(*)`,
      lastDate: max(transactions.date),
    })
    .from(transactions)
    .where(inArray(transactions.batchId, batchIds))
    .groupBy(transactions.batchId);

  const mappings = await tx
    .select({ id: importBatches.id, columnMapping: importBatches.columnMapping })
    .from(importBatches)
    .where(inArray(importBatches.id, batchIds));
  const closingByBatch = new Map<number, number | null>();
  for (const m of mappings) {
    const cm = (m.columnMapping ?? {}) as Record<string, unknown>;
    // El lector por texto guarda `closingBalance`, el visual `saldoActual`, a veces como string.
    const raw = Number(cm.closingBalance ?? cm.saldoActual);
    closingByBatch.set(m.id, Number.isFinite(raw) && raw !== 0 ? Math.abs(raw) : null);
  }

  for (const t of totals) {
    if (!t.lastDate) continue;
    info.set(t.batchId, {
      total: Number(t.total),
      rowCount: Number(t.rowCount),
      closing: closingByBatch.get(t.batchId) ?? null,
      lastDate: t.lastDate,
    });
  }
  return info;
}

function runCardStatementMatch(
  pool: Txn[],
  opts: Required<EngineOptions>,
  rejected: RejectedPairs,
  batchInfo: Map<number, CardBatchInfo>,
): StepResult {
  const used = new Set<number>();
  const specs: MatchSpec[] = [];
  const tolerance = Math.max(opts.amountTolerance, CARD_TOTAL_TOLERANCE);

  const cardRows = pool.filter((t) => t.source === "card");
  const bankRows = pool.filter((t) => t.source === "bank");

  const byBatch = new Map<number, Txn[]>();
  for (const row of cardRows) {
    if (!byBatch.has(row.batchId)) byBatch.set(row.batchId, []);
    byBatch.get(row.batchId)!.push(row);
  }

  for (const [batchId, rows] of byBatch) {
    const info = batchInfo.get(batchId);
    if (!info || Math.abs(info.total) === 0) continue;
    if (rows.some((r) => used.has(r.id))) continue;

    // Importes que puede tener el pago: el saldo impreso del resumen (el que de verdad debita el banco) o la suma de todas sus filas.
    const expected = [
      ...(info.closing !== null ? [{ amount: info.closing, label: "saldo del resumen" }] : []),
      { amount: Math.abs(info.total), label: "suma de todos los consumos" },
    ];

    const eligible = (b: Txn) =>
      !used.has(b.id) &&
      Math.sign(Number(b.amount)) === Math.sign(info.total) &&
      !rows.some((r) => rejected.has(pairKey(r.id, b.id))) &&
      b.date.getTime() >= info.lastDate.getTime() - CARD_PAYMENT_DAYS_BEFORE * DAY_MS &&
      b.date.getTime() <= info.lastDate.getTime() + CARD_PAYMENT_DAYS_AFTER * DAY_MS;

    const exactHit = (b: Txn) => {
      const diffs = expected.map((e) => ({ e, diff: Math.abs(Math.abs(Number(b.amount)) - e.amount) }));
      return diffs.filter((d) => d.diff <= tolerance).sort((x, y) => x.diff - y.diff)[0] ?? null;
    };

    const candidates = bankRows.filter((b) => eligible(b) && exactHit(b));

    if (candidates.length === 1) {
      const bank = candidates[0];
      const hit = exactHit(bank)!;
      for (const r of rows) used.add(r.id);
      used.add(bank.id);
      specs.push({
        strategy: "card_statement_1toN",
        status: "auto",
        confidence: 90,
        amountDiff: hit.diff,
        transactionIds: [...rows.map((r) => r.id), bank.id],
        note: `Resumen de tarjeta (${rows.length} consumos libres de ${info.rowCount}) vs pago bancario — coincide con la ${hit.e.label}`,
      });
      continue;
    }

    // Sin pago que cierre (resumen cargado en dos archivos, un cargo que no
    // figura en el detalle, etc.): si hay UN solo pago bancario a menos del 1%
    // del total en la misma ventana, se propone como sugerencia para revisar —
    // nunca se auto-confirma.
    if (candidates.length === 0) {
      const base = expected[0].amount;
      const near = bankRows.filter(
        (b) => eligible(b) && Math.abs(Math.abs(Number(b.amount)) - base) / base <= CARD_NEAR_TOTAL_PCT,
      );

      if (near.length === 1) {
        const bank = near[0];
        const diff = Math.abs(Math.abs(Number(bank.amount)) - base);
        for (const r of rows) used.add(r.id);
        used.add(bank.id);
        specs.push({
          strategy: "card_statement_1toN",
          status: "pending",
          confidence: 60,
          amountDiff: diff,
          transactionIds: [...rows.map((r) => r.id), bank.id],
          note: `Sugerencia automática — resumen de tarjeta (${rows.length} consumos libres de ${info.rowCount}) vs pago bancario que NO cierra exacto contra la ${expected[0].label} (diferencia de ${diff.toFixed(2)}). Revisar si falta algún consumo o cargo.`,
        });
      }
    }
  }

  return { specs, remaining: pool.filter((t) => !used.has(t.id)) };
}

/**
 * Estrategia 3: candidatos fuzzy para revisión manual (nunca se auto-confirman).
 * Compara importe con tolerancia porcentual + similitud de texto entre
 * descripción/contraparte, dentro de una ventana de fecha más amplia.
 */
// Para cuando no hay NINGUNA palabra en común entre descripción/contraparte
// (ej. un consumo de tarjeta en una estación de servicio con nombre de
// fantasía — "AXION LA BANDERA" — contra la factura AFIP a nombre de la
// razón social real que la opera — "OPERADORA DE ESTACIONES DE SERVICIOS
// SA" — que no comparten ninguna palabra): no alcanza con "importe
// parecido" (eso es justo el bug de BOLDT/YPF que nos hizo exigir texto),
// pero un importe CASI EXACTO (no "parecido") + fecha pegada sigue siendo
// una señal fuerte por sí sola — la chance de que dos movimientos de
// cualquier billetera del mundo coincidan en centavos y encima caigan a
// días de diferencia es bajísima. Mucho más estricto que la tolerancia
// fuzzy normal (4% / ventana amplia) para no reabrir ese bug.
const NO_TEXT_AMOUNT_TOLERANCE_PCT = 0.005; // 0.5%
const NO_TEXT_DATE_WINDOW_DAYS = 10;

function runFuzzySuggestions(pool: Txn[], opts: Required<EngineOptions>, rejected: RejectedPairs): StepResult {
  const used = new Set<number>();
  const specs: MatchSpec[] = [];
  const wideWindow = opts.dateWindowDays * 3;
  const maxPct = opts.fuzzyAmountTolerancePct * 2; // hasta 4% de diferencia (antes 10%, dejaba pasar importes "parecidos" sin ninguna otra relación)

  // Pool ordenado por importe absoluto: el rango de importes candidatos de
  // cada movimiento se acota con búsqueda binaria en vez de recorrer todo.
  const sorted = pool
    .map((txn, idx) => ({ txn, idx, abs: Math.abs(Number(txn.amount)) }))
    .sort((x, y) => x.abs - y.abs);

  const lowerBound = (value: number) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].abs < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  for (let i = 0; i < pool.length; i++) {
    const a = pool[i];
    if (used.has(a.id)) continue;
    const amountA = Number(a.amount);
    const absA = Math.abs(amountA);

    let best: {
      txn: Txn;
      idx: number;
      score: number;
      amountDiff: number;
      noText: boolean;
      cuitMatch: boolean;
    } | null = null;

    // pctDiff se mide contra max(|a|, 0.01); el margen extra es solo por redondeo, el chequeo exacto está abajo.
    const reach = maxPct * Math.max(absA, 0.01) * 1.001 + 0.005;
    for (let s = lowerBound(absA - reach); s < sorted.length && sorted[s].abs <= absA + reach; s++) {
      const { txn: b, idx: j } = sorted[s];
      if (i === j) continue;
      if (used.has(b.id)) continue;
      if (b.source === a.source) continue;
      if (!canSourcesMatch(a.source, b.source)) continue;
      if (rejected.has(pairKey(a.id, b.id))) continue; // ya lo rechazaron a mano: no volver a proponerlo
      const amountB = Number(b.amount);
      if (Math.sign(amountA) !== Math.sign(amountB)) continue;

      const pctDiff = Math.abs(absA - Math.abs(amountB)) / Math.max(absA, 0.01);
      const daysDiff = daysBetween(a.date, b.date);
      if (pctDiff > maxPct) continue;
      if (daysDiff > fuzzyMaxDays(a.source, b.source, wideWindow)) continue;

      const textScore = jaccardSimilarity(
        `${a.description} ${a.counterparty ?? ""}`,
        `${b.description} ${b.counterparty ?? ""}`,
      );

      // El CUIT es una identificación mucho más fuerte que cualquier
      // similitud de texto: muchas transferencias de banco traen el CUIT
      // del destinatario pegado en la descripción ("...30717665011"), y la
      // factura AFIP siempre tiene el CUIT real en `counterparty`. Si
      // aparece el MISMO CUIT de los dos lados, se trata como evidencia de
      // texto perfecta (score 1) — la chance de que coincida un número de
      // 11 dígitos por azar es insignificante. (No existe para `card`: el
      // resumen de tarjeta no imprime CUIT del comercio, solo nombre.)
      const cuitsA = extractCuits(`${a.description} ${a.counterparty ?? ""}`);
      const cuitsB = extractCuits(`${b.description} ${b.counterparty ?? ""}`);
      const cuitMatch = cuitsA.length > 0 && cuitsA.some((c) => cuitsB.includes(c));

      // Un importe parecido por sí solo no alcanza para sugerir un match: con
      // textScore 0 (ninguna palabra en común entre descripción/contraparte)
      // dos movimientos de cualquier billetera del mundo pueden "coincidir" en
      // monto por pura casualidad (bug real reportado: factura AFIP de BOLDT
      // vs. consumo de tarjeta en YPF, mismo importe aproximado, cero relación).
      // Se exige evidencia de texto real antes de mirar siquiera el importe...
      // salvo que el importe sea CASI EXACTO y la fecha esté pegada (ver
      // NO_TEXT_AMOUNT_TOLERANCE_PCT arriba) o que coincida el CUIT — eso
      // sigue pasando el filtro, nunca se auto-confirma, solo entra como
      // sugerencia para revisar.
      const passesNoText = pctDiff <= NO_TEXT_AMOUNT_TOLERANCE_PCT && daysDiff <= NO_TEXT_DATE_WINDOW_DAYS;
      if (textScore <= 0 && !passesNoText && !cuitMatch) continue;

      const effectiveTextScore = cuitMatch ? 1 : textScore;
      const amountScore = 1 - Math.min(pctDiff / maxPct, 1);
      const score = effectiveTextScore <= 0 ? amountScore * 0.5 : effectiveTextScore * 0.6 + amountScore * 0.4;

      // Ante un empate de score gana el que viene primero en el pool (más
      // antiguo), igual que cuando se recorría el pool en orden.
      if (score > 0.35 && (!best || score > best.score || (score === best.score && j < best.idx))) {
        best = {
          txn: b,
          idx: j,
          score,
          amountDiff: Math.abs(absA - Math.abs(amountB)),
          noText: textScore <= 0 && !cuitMatch,
          cuitMatch,
        };
      }
    }

    if (best) {
      used.add(a.id);
      used.add(best.txn.id);
      specs.push({
        strategy: "fuzzy",
        status: "pending",
        confidence: Math.round(best.score * 100),
        amountDiff: best.amountDiff,
        transactionIds: [a.id, best.txn.id],
        note: best.cuitMatch
          ? "Sugerencia automática — mismo CUIT encontrado en los dos movimientos. Alta confianza, pero igual requiere confirmación manual."
          : best.noText
            ? "Sugerencia automática — importe casi exacto y fecha cercana, pero SIN ninguna palabra en común (ej. nombre de fantasía vs. razón social). Revisar con cuidado antes de confirmar."
            : "Sugerencia automática — requiere confirmación manual",
      });
    }
  }

  return { specs, remaining: pool.filter((t) => !used.has(t.id)) };
}

export async function runMatchingEngine(options: EngineOptions = {}) {
  const opts = { ...DEFAULTS, ...options };

  // Toda la corrida es una sola transacción con candado: las 3 estrategias se
  // calculan en memoria y los matches se escriben juntos al final, así que o
  // queda todo o no queda nada (antes un corte a mitad dejaba un `matches`
  // sin `match_items`, o movimientos matcheados a medias). Ojo: la conexión
  // es una sola (`max: 1`), todo lo de adentro tiene que usar `tx`, no `db`.
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(String(ENGINE_LOCK_ID))})`);

    // Las sugerencias pendientes (que nadie revisó todavía) se recalculan en
    // cada corrida en vez de quedar congeladas: una sugerencia ocupa a sus
    // movimientos, así que una sugerencia floja del motor viejo (ej. el pago a
    // Aragno emparejado con la factura de NOSIS por tener un importe parecido)
    // impedía que el motor nuevo viera la factura correcta del mismo importe,
    // que quedaba libre para siempre. Lo ya decidido (confirmado, manual,
    // automático, rechazado) no se toca; los pares rechazados se recuerdan
    // aparte (ver `getRejectedPairs`) para no volver a proponerlos.
    await tx.delete(matches).where(eq(matches.status, "pending"));

    // Lo "Pendiente de pago" que ya se concilió deja de ser deuda abierta.
    await releasePendingPaymentCategory((q) => tx.execute(q));

    // Se sacan del pool, antes de correr cualquiera de las 3 estrategias, los
    // movimientos que YA NO necesitan conciliar:
    // - `t.category` seteado: categorizado a mano o automático (comisiones de
    //   tarjeta, impuestos, retiros, honorarios, etc.) sin importar la fuente
    //   — antes acá solo se chequeaba `isNonReconcilableBankMovement`, que
    //   únicamente mira `source === 'bank'`, así que los categorizados de
    //   TARJETA (ver fee-categories.ts) nunca se sacaban: quedaban dando
    //   vueltas en cada corrida, sin poder matchear nunca con nada (no tienen
    //   contraparte), e inflaban el contador de "sin resolver" con movimientos
    //   que en realidad ya estaban resueltos.
    // - `isNonReconcilableBankMovement`: movimientos bancarios "internos"
    //   (impuestos, comisiones, transferencias entre cuentas propias) que
    //   todavía no se categorizaron pero nunca van a tener una contraparte
    //   real — no son pagos a/de terceros.
    // - Excepción: "Pendientes de pago" (facturas que todavía no se pagaron) SÍ
    //   entran al pool, porque el día que aparezca el pago tienen que cruzar.
    const { pool: unmatched, statementPaidCardIds } = await getUnmatchedTransactions(tx);
    const pool0 = unmatched.filter(
      (t) => (!t.category || t.category === PENDING_PAYMENT_CATEGORY) && !isNonReconcilableBankMovement(t),
    );

    const rejected = await getRejectedPairs(tx);

    const step1 = runExact1to1(pool0, opts, rejected);
    // Compras en cuotas contra la factura por el total: antes del cruce con el
    // pago del resumen, que se llevaría todas las cuotas libres del lote.
    const stepInstallments = runInstallments(step1.remaining, rejected);
    const cardBatchIds = [...new Set(stepInstallments.remaining.filter((t) => t.source === "card").map((t) => t.batchId))];
    const cardBatchInfo = await getCardBatchInfo(tx, cardBatchIds);
    const step2 = runCardStatementMatch(
      stepInstallments.remaining.filter((t) => !statementPaidCardIds.has(t.id)),
      opts,
      rejected,
      cardBatchInfo,
    );
    // El cruce del resumen solo prueba que los consumos se pagaron: los consumos
    // siguen en el pool para encontrar su factura (por nombre, varias facturas,
    // pago parcial, fuzzy). El débito del banco sí queda usado.
    const usedByStatement = new Set(step2.specs.flatMap((s) => s.transactionIds));
    const afterStatement = stepInstallments.remaining.filter((t) => t.source === "card" || !usedByStatement.has(t.id));
    const paidCard = (t: Txn) => statementPaidCardIds.has(t.id) || (t.source === "card" && usedByStatement.has(t.id));
    // Las facturas anuladas por una nota de crédito se sacan antes de armar los
    // grupos por cliente: se cancelan entre sí y no tienen pago que cruzar.
    const stepCredit = runCreditNotes(afterStatement, opts, rejected);
    // Transferencia con el CUIT y el importe exacto de una factura, aunque esta
    // se emita bastante después (pago adelantado): el cruce por CUIT mira 7 días.
    // Cobros que llegan netos de la retención de Ganancias: depósito + certificados = facturas.
    const stepRetentions = runRetentions(stepCredit.remaining, rejected);
    const stepCuitExact = runCuitExactWide(stepRetentions.remaining, rejected);
    const stepCuit = runCuitGroups(stepCuitExact.remaining, opts, rejected);
    // Transferencias que no dicen a quién se pagaron (MacrOnline): una o varias
    // facturas del mismo proveedor cuya suma cierra exacto.
    const stepPayment = runPaymentGroups(stepCuit.remaining, opts, rejected);
    // Una factura pagada en 2-3 partes y consumos de tarjeta con el mismo nombre
    // que el proveedor: solo sugerencias, van antes del fuzzy genérico.
    // Pago por transferencia hasta 45 días después de la factura (la tarjeta se queda en 2 días).
    const stepBankWide = runBankWideWindow(stepPayment.remaining, rejected);
    const stepSplit = runSplitPayments(stepBankWide.remaining, rejected);
    const stepCardName = runCardNameMatches(stepSplit.remaining, rejected);
    // Un consumo que cubre varias facturas del mismo carrito o comercio.
    const stepCardMulti = runCardMultiInvoice(stepCardName.remaining, rejected);
    const stepPartial = runPartialCardPayments(stepCardMulti.remaining, rejected);
    const stepExtra = runRoundExtra(stepPartial.remaining, rejected);
    const step3 = runFuzzySuggestions(stepExtra.remaining, opts, rejected);

    await persistMatches(tx, [
      ...step1.specs,
      ...stepInstallments.specs,
      ...step2.specs,
      ...stepCredit.specs,
      ...stepRetentions.specs,
      ...stepCuitExact.specs,
      ...stepCuit.specs,
      ...stepPayment.specs,
      ...stepBankWide.specs,
      ...stepSplit.specs,
      ...stepCardName.specs,
      ...stepCardMulti.specs,
      ...stepPartial.specs,
      ...stepExtra.specs,
      ...step3.specs,
    ]);

    // Las facturas pendientes de pago que acaban de cruzar dejan de serlo.
    await releasePendingPaymentCategory((q) => tx.execute(q));

    return {
      exactMatches: step1.specs.length + stepInstallments.specs.length +
        stepCuitExact.specs.length +
        stepBankWide.specs.filter((x) => x.status === "auto").length +
        stepCardMulti.specs.filter((x) => x.status === "auto").length,
      cardStatementMatches: step2.specs.length,
      creditNoteMatches: stepCredit.specs.length,
      cuitGroupMatches: stepCuit.specs.length + stepRetentions.specs.length,
      paymentGroupMatches: stepPayment.specs.length,
      fuzzySuggestions:
        step3.specs.length +
        stepSplit.specs.length +
        stepCardName.specs.length +
        stepPartial.specs.length +
        stepExtra.specs.length +
        stepBankWide.specs.filter((x) => x.status === "pending").length +
        stepCardMulti.specs.filter((x) => x.status === "pending").length,
      // La deuda abierta no cuenta como "sin resolver": no hay un pago contra el cual cruzarla.
      stillUnmatched: step3.remaining.filter((t) => t.category !== PENDING_PAYMENT_CATEGORY && !paidCard(t)).length,
    };
  });
}
