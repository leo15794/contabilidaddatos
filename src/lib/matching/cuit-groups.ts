import { extractCuits } from "./cuit";
import { pairKey, type MatchSpec, type RejectedPairs, type StepResult, type Txn } from "./types";

/**
 * Estrategia por cliente/proveedor (CUIT): un pago que cubre VARIAS facturas
 * (o varios pagos que cubren una factura), con una diferencia chica porque el
 * cliente descuenta retenciones. El motor 1 a 1 nunca lo resuelve.
 *
 * Ejemplo real (Boldt, 30717606392): en febrero 2026 las facturas netas de
 * notas de crédito suman $57,48 M y el cliente depositó $56,33 M (98%). Por
 * CUIT los totales de todo el período cierran casi al peso (387,5 M cobrados
 * contra 383,4 M facturados), pero cada depósito paga un grupo distinto.
 *
 * - Cobros: depósito del banco (importe > 0) contra facturas EMITIDAS del mismo CUIT.
 * - Pagos: transferencia del banco (importe < 0) contra facturas RECIBIDAS del mismo CUIT.
 *
 * El CUIT del banco sale de la descripción ("TEF DATANET PR BOLDT ... 30717606392",
 * "TRANSF:...-30717898733"); el del comprobante, de `counterparty`.
 *
 * Los grupos son ventanas CONTIGUAS de comprobantes ordenados por fecha (los
 * clientes pagan por período, no salteando facturas del medio) y solo se
 * auto-confirman si la suma cierra al centavo; si hay diferencia (retenciones)
 * quedan como sugerencia para confirmar de un clic.
 */

// Qué fracción del total facturado puede llegar como pago (retenciones, descuentos).
const MIN_RATIO = 0.93;
const MAX_RATIO = 1.005;
const MAX_GROUP_SIZE = 12;
// Un pago cubre comprobantes emitidos hasta 120 días antes (o unos días después, por desfasajes de carga).
const DOC_LOOKBACK_DAYS = 120;
const DOC_LOOKAHEAD_DAYS = 7;
// Penalización (en puntos de ratio) por cada comprobante más viejo que se saltea: lo normal es que se paguen en orden.
const SKIP_PENALTY = 0.01;

const DAY_MS = 24 * 60 * 60 * 1000;

type Side = "cobros" | "pagos";

type Window = { items: Txn[]; sum: number; ratio: number; skipped: number; penalty: number };

function cuitOf(doc: Txn): string | null {
  return extractCuits(doc.counterparty)[0] ?? null;
}

/**
 * Mejor ventana contigua de `items` (ya ordenados por fecha) cuya suma, contra
 * `target`, cae en el rango de ratio permitido. `ratioOf` define de qué lado
 * está cada cosa: ratio = (lado de los pagos) / (lado de los comprobantes).
 */
function findBestWindow(
  items: Txn[],
  ratioOf: (sum: number) => number,
  expectedSign: number,
  isRejected: (t: Txn) => boolean,
  minSize: number,
): Window | null {
  let best: Window | null = null;

  for (let s = 0; s < items.length; s++) {
    let sum = 0;
    const skipped = items.slice(0, s).filter((t) => Math.sign(Number(t.amount)) === expectedSign).length;

    for (let e = s; e < items.length && e - s < MAX_GROUP_SIZE; e++) {
      sum += Number(items[e].amount);
      if (items.slice(s, e + 1).some(isRejected)) break; // si algún par ya fue rechazado a mano, ninguna ventana más larga lo repara
      if (e - s + 1 < minSize) continue;
      if (Math.sign(sum) !== expectedSign) continue;

      const ratio = ratioOf(sum);
      if (ratio < MIN_RATIO || ratio > MAX_RATIO) continue;

      const penalty = Math.abs(1 - ratio) + skipped * SKIP_PENALTY;
      // En empate, la ventana que arranca primero (más vieja).
      if (!best || penalty < best.penalty - 1e-12) {
        best = { items: items.slice(s, e + 1), sum, ratio, skipped, penalty };
      }
    }
  }

  return best;
}

const fmt = (n: number) => Math.abs(n).toLocaleString("es-AR", { maximumFractionDigits: 2 });

export function runCuitGroups(
  pool: Txn[],
  opts: { amountTolerance: number },
  rejected: RejectedPairs,
): StepResult {
  const used = new Set<number>();
  const specs: MatchSpec[] = [];

  // Comprobantes por lado y CUIT.
  const docsByKey = new Map<string, Txn[]>();
  for (const t of pool) {
    const side: Side | null = t.source === "afip_issued" ? "cobros" : t.source === "afip_received" ? "pagos" : null;
    if (!side) continue;
    const cuit = cuitOf(t);
    if (!cuit) continue;
    const key = `${side}:${cuit}`;
    const list = docsByKey.get(key);
    if (list) list.push(t);
    else docsByKey.set(key, [t]);
  }

  // Pagos del banco: el lado sale del signo y el CUIT de la descripción, pero solo
  // cuenta si ese CUIT tiene comprobantes en el mismo lado.
  const paymentsByKey = new Map<string, Txn[]>();
  for (const t of pool) {
    if (t.source !== "bank") continue;
    const amount = Number(t.amount);
    if (amount === 0) continue;
    const side: Side = amount > 0 ? "cobros" : "pagos";
    const cuits = extractCuits(`${t.description} ${t.counterparty ?? ""}`);
    const key = cuits.map((c) => `${side}:${c}`).find((k) => docsByKey.has(k));
    if (!key) continue;
    const list = paymentsByKey.get(key);
    if (list) list.push(t);
    else paymentsByKey.set(key, [t]);
  }

  const byDate = (a: Txn, b: Txn) => a.date.getTime() - b.date.getTime() || a.id - b.id;

  for (const [key, payments] of paymentsByKey) {
    const side = key.startsWith("cobros") ? "cobros" : "pagos";
    const cuit = key.split(":")[1];
    const docs = (docsByKey.get(key) ?? []).slice().sort(byDate);
    const sortedPayments = payments.slice().sort(byDate);
    const expectedSign = side === "cobros" ? 1 : -1;

    const pushSpec = (paymentsInGroup: Txn[], docsInGroup: Txn[], paymentTotal: number, docsTotal: number, ratio: number) => {
      const diff = Math.abs(Math.abs(paymentTotal) - Math.abs(docsTotal));
      const n = paymentsInGroup.length + docsInGroup.length - 1;
      const exact = diff <= opts.amountTolerance && n >= 2;
      const conf = Math.max(35, Math.min(95, Math.round(92 - Math.abs(1 - ratio) * 350 - (n - 1) * 2)));
      const payLabel = side === "cobros" ? "depósito" : "pago";
      const docLabel = side === "cobros" ? "facturas emitidas" : "facturas recibidas";
      for (const t of [...paymentsInGroup, ...docsInGroup]) used.add(t.id);
      specs.push({
        strategy: "cuit_group",
        status: exact ? "auto" : "pending",
        confidence: exact ? 90 : conf,
        amountDiff: diff,
        transactionIds: [...paymentsInGroup, ...docsInGroup].map((t) => t.id),
        note: `Grupo por CUIT ${cuit}: ${paymentsInGroup.length} ${payLabel}${paymentsInGroup.length > 1 ? "s" : ""} por $${fmt(paymentTotal)} contra ${docsInGroup.length} ${docLabel} (neto de notas de crédito) por $${fmt(docsTotal)} — el ${payLabel} es el ${(ratio * 100).toFixed(1)}% de lo facturado${exact ? "" : " (la diferencia suele ser retenciones)"}.`,
      });
    };

    // A) un pago cubre varios comprobantes (o uno solo con diferencia por retenciones).
    for (const p of sortedPayments) {
      if (used.has(p.id)) continue;
      const pTime = p.date.getTime();
      const candidates = docs.filter(
        (d) =>
          !used.has(d.id) &&
          d.date.getTime() >= pTime - DOC_LOOKBACK_DAYS * DAY_MS &&
          d.date.getTime() <= pTime + DOC_LOOKAHEAD_DAYS * DAY_MS,
      );
      if (candidates.length === 0) continue;

      const pAmount = Number(p.amount);
      const win = findBestWindow(
        candidates,
        (sum) => pAmount / sum,
        expectedSign,
        (d) => rejected.has(pairKey(p.id, d.id)),
        1,
      );
      if (win) pushSpec([p], win.items, pAmount, win.sum, win.ratio);
    }

    // B) varios pagos parciales cubren un solo comprobante (mínimo 2 pagos).
    for (const d of docs) {
      if (used.has(d.id)) continue;
      const dAmount = Number(d.amount);
      if (Math.sign(dAmount) !== expectedSign) continue; // las notas de crédito sueltas no se pagan
      const dTime = d.date.getTime();
      const candidates = sortedPayments.filter(
        (p) =>
          !used.has(p.id) &&
          p.date.getTime() >= dTime - DOC_LOOKAHEAD_DAYS * DAY_MS &&
          p.date.getTime() <= dTime + DOC_LOOKBACK_DAYS * DAY_MS,
      );
      if (candidates.length < 2) continue;

      const win = findBestWindow(
        candidates,
        (sum) => sum / dAmount,
        expectedSign,
        (p) => rejected.has(pairKey(p.id, d.id)),
        2,
      );
      if (win) pushSpec(win.items, [d], win.sum, dAmount, win.ratio);
    }
  }

  return { specs, remaining: pool.filter((t) => !used.has(t.id)) };
}
