import { asc, eq, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { matchItems, matches, transactions } from "@/db/schema";
import { jaccardSimilarity } from "./text-similarity";
import { isNonReconcilableBankMovement } from "./exclusions";
import { extractCuits } from "./cuit";

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
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Un movimiento de pago (banco/tarjeta) solo puede conciliar contra un
// justificativo (factura AFIP o ticket), nunca contra otro movimiento de
// pago ni —el bug que reportó Leo— una factura emitida contra una recibida:
// son dos comprobantes propios, no un pago real cruzando con un comprobante.
const MOVEMENT_SOURCES = new Set(["bank", "card"]);
const JUSTIFICATION_SOURCES = new Set(["afip_issued", "afip_received", "ticket"]);

function canSourcesMatch(a: string, b: string): boolean {
  return (
    (MOVEMENT_SOURCES.has(a) && JUSTIFICATION_SOURCES.has(b)) ||
    (MOVEMENT_SOURCES.has(b) && JUSTIFICATION_SOURCES.has(a))
  );
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24);
}

// Candado de Postgres para que dos corridas del motor a la vez (ej. un import
// y un ticket de WhatsApp llegando juntos, posiblemente en instancias
// distintas de Vercel) no armen matches duplicados sobre los mismos movimientos.
const ENGINE_LOCK_ID = 727001;

async function getUnmatchedTransactions(tx: Tx): Promise<Txn[]> {
  // Transacciones que no están en ningún match con estado != 'rejected'.
  const matchedIds = tx
    .select({ id: matchItems.transactionId })
    .from(matchItems)
    .innerJoin(matches, eq(matches.id, matchItems.matchId))
    .where(sql`${matches.status} != 'rejected'`);

  return tx
    .select()
    .from(transactions)
    .where(notInArray(transactions.id, matchedIds))
    .orderBy(asc(transactions.date));
}

// Pares de movimientos que ya se rechazaron a mano. Un match rechazado libera
// a sus movimientos, y sin esto el motor volvía a proponer el mismo par idéntico
// en la corrida siguiente. Un match de varios movimientos aporta todos sus pares.
type RejectedPairs = Set<string>;
const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

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

/** Un match calculado en memoria; se persiste todo junto al final de la corrida (ver `persistMatches`). */
type MatchSpec = {
  strategy: "exact_1to1" | "card_statement_1toN" | "fuzzy";
  status: "auto" | "pending";
  confidence: number;
  amountDiff: number;
  transactionIds: number[];
  note?: string;
};

type StepResult = { specs: MatchSpec[]; remaining: Txn[] };

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
  const spanCents = Math.ceil(opts.amountTolerance * 100) + 1;

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
        if (rejected.has(pairKey(a.id, b.id))) continue; // ya lo rechazaron a mano: no volver a proponerlo

        const amountB = Number(b.amount);

        const sameSign = Math.sign(amountA) === Math.sign(amountB);
        const amountClose = Math.abs(Math.abs(amountA) - Math.abs(amountB)) <= opts.amountTolerance;
        const dateClose = daysBetween(a.date, b.date) <= opts.dateWindowDays;

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
 * Estrategia 2: agrupa los consumos de tarjeta de un mismo lote de importación
 * (= un resumen) y los suma contra un pago bancario único dentro de una
 * ventana de fecha más amplia (el pago del resumen suele ser 10-20 días después
 * del cierre).
 */
// Diferencia máxima (sobre el total del resumen) para sugerir un pago que no cierra exacto.
const CARD_NEAR_TOTAL_PCT = 0.01;

function runCardStatementMatch(pool: Txn[], opts: Required<EngineOptions>, rejected: RejectedPairs): StepResult {
  const used = new Set<number>();
  const specs: MatchSpec[] = [];

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
      if (rows.some((r) => rejected.has(pairKey(r.id, b.id)))) return false;
      const amountClose = Math.abs(Math.abs(Number(b.amount)) - Math.abs(total)) <= opts.amountTolerance;
      // ventana más amplia: el pago puede ser hasta 25 días después del último consumo
      const withinWindow = b.date >= lastDate && daysBetween(b.date, lastDate) <= 25;
      return amountClose && withinWindow;
    });

    if (candidates.length === 1) {
      const bank = candidates[0];
      for (const r of rows) used.add(r.id);
      used.add(bank.id);
      specs.push({
        strategy: "card_statement_1toN",
        status: "auto",
        confidence: 90,
        amountDiff: Math.abs(Math.abs(Number(bank.amount)) - Math.abs(total)),
        transactionIds: [...rows.map((r) => r.id), bank.id],
        note: `Resumen de tarjeta (${rows.length} consumos) vs pago bancario`,
      });
      continue;
    }

    // Sin pago que cierre al centavo (resumen cargado en dos archivos, un
    // cargo que no figura en el detalle, etc.): si hay UN solo pago bancario
    // a menos del 1% del total en la misma ventana, se propone como
    // sugerencia para revisar — nunca se auto-confirma.
    if (candidates.length === 0 && Math.abs(total) > 0) {
      const near = bankRows.filter((b) => {
        if (used.has(b.id)) return false;
        if (rows.some((r) => rejected.has(pairKey(r.id, b.id)))) return false;
        const pct = Math.abs(Math.abs(Number(b.amount)) - Math.abs(total)) / Math.abs(total);
        const withinWindow = b.date >= lastDate && daysBetween(b.date, lastDate) <= 25;
        return pct <= CARD_NEAR_TOTAL_PCT && withinWindow;
      });

      if (near.length === 1) {
        const bank = near[0];
        for (const r of rows) used.add(r.id);
        used.add(bank.id);
        specs.push({
          strategy: "card_statement_1toN",
          status: "pending",
          confidence: 60,
          amountDiff: Math.abs(Math.abs(Number(bank.amount)) - Math.abs(total)),
          transactionIds: [...rows.map((r) => r.id), bank.id],
          note: `Sugerencia automática — resumen de tarjeta (${rows.length} consumos) vs pago bancario que NO cierra exacto (diferencia de ${Math.abs(Math.abs(Number(bank.amount)) - Math.abs(total)).toFixed(2)}). Revisar si falta algún consumo o cargo.`,
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
      if (daysDiff > wideWindow) continue;

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
    const pool0 = (await getUnmatchedTransactions(tx)).filter(
      (t) => !t.category && !isNonReconcilableBankMovement(t),
    );

    const rejected = await getRejectedPairs(tx);

    const step1 = runExact1to1(pool0, opts, rejected);
    const step2 = runCardStatementMatch(step1.remaining, opts, rejected);
    const step3 = runFuzzySuggestions(step2.remaining, opts, rejected);

    await persistMatches(tx, [...step1.specs, ...step2.specs, ...step3.specs]);

    return {
      exactMatches: step1.specs.length,
      cardStatementMatches: step2.specs.length,
      fuzzySuggestions: step3.specs.length,
      stillUnmatched: step3.remaining.length,
    };
  });
}
