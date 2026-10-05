import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { importBatches, matchItems, matches, transactions } from "@/db/schema";
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
      if (!canSourcesMatch(a.source, b.source)) continue; // y tiene que ser pago<->justificativo, no dos comprobantes propios

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

async function runFuzzySuggestions(pool: Txn[], opts: Required<EngineOptions>) {
  const used = new Set<number>();
  let created = 0;
  const wideWindow = opts.dateWindowDays * 3;

  for (let i = 0; i < pool.length; i++) {
    const a = pool[i];
    if (used.has(a.id)) continue;
    const amountA = Number(a.amount);

    let best: { txn: Txn; score: number; amountDiff: number; noText: boolean; cuitMatch: boolean } | null = null;

    for (let j = 0; j < pool.length; j++) {
      if (i === j) continue;
      const b = pool[j];
      if (used.has(b.id)) continue;
      if (b.source === a.source) continue;
      if (!canSourcesMatch(a.source, b.source)) continue;
      const amountB = Number(b.amount);
      if (Math.sign(amountA) !== Math.sign(amountB)) continue;

      const pctDiff = Math.abs(Math.abs(amountA) - Math.abs(amountB)) / Math.max(Math.abs(amountA), 0.01);
      const daysDiff = daysBetween(a.date, b.date);
      if (pctDiff > opts.fuzzyAmountTolerancePct * 2) continue; // hasta 4% de diferencia (antes 10%, dejaba pasar importes "parecidos" sin ninguna otra relación)
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
      const amountScore = 1 - Math.min(pctDiff / (opts.fuzzyAmountTolerancePct * 2), 1);
      const score = effectiveTextScore <= 0 ? amountScore * 0.5 : effectiveTextScore * 0.6 + amountScore * 0.4;

      if (score > 0.35 && (!best || score > best.score)) {
        best = {
          txn: b,
          score,
          amountDiff: Math.abs(Math.abs(amountA) - Math.abs(amountB)),
          noText: textScore <= 0 && !cuitMatch,
          cuitMatch,
        };
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
        best.cuitMatch
          ? "Sugerencia automática — mismo CUIT encontrado en los dos movimientos. Alta confianza, pero igual requiere confirmación manual."
          : best.noText
            ? "Sugerencia automática — importe casi exacto y fecha cercana, pero SIN ninguna palabra en común (ej. nombre de fantasía vs. razón social). Revisar con cuidado antes de confirmar."
            : "Sugerencia automática — requiere confirmación manual",
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
