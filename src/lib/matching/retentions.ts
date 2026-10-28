import { extractCuits } from "./cuit";
import { pairKey, type MatchSpec, type RejectedPairs, type StepResult, type Txn } from "./types";

/**
 * Cobros con retención: el cliente (Boldt, Casino Puerto Santa Fe) deposita la
 * factura MENOS la retención de Ganancias que practica, y manda el certificado.
 * Depósito + retenciones del mismo cliente y del mismo día = las facturas que
 * paga. Ej.: factura $4.072.936,94 = depósito $4.006.959,07 + retención
 * $65.977,87 (certificado 0004-2025-001685 del Casino).
 *
 * - Las retenciones (fuente "retention") se juntan con el depósito del banco que
 *   trae el CUIT del mismo cliente, el mismo día o el siguiente.
 * - Se busca entre las facturas emitidas libres de ese CUIT (notas de crédito
 *   incluidas, que restan) un conjunto de hasta MAX_DOCS que sume exacto.
 * - Solo si hay una única forma de armarlo; se confirma solo.
 *
 * Las retenciones que no se pudieron unir quedan fuera del resto de los pasos:
 * una retención suelta nunca es el pago entero de una factura.
 */
const MAX_DOCS = 5;
const MAX_CANDIDATES = 12;
const DOC_LOOKBACK_DAYS = 120;
const DOC_LOOKAHEAD_DAYS = 5;
const TOLERANCE = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

function combinations<T>(items: T[], size: number, visit: (combo: T[]) => void) {
  const combo: T[] = [];
  const rec = (start: number) => {
    if (combo.length === size) {
      visit([...combo]);
      return;
    }
    for (let i = start; i < items.length; i++) {
      combo.push(items[i]);
      rec(i + 1);
      combo.pop();
    }
  };
  rec(0);
}

const cuitOf = (t: Txn) =>
  t.source === "retention" || t.source === "afip_issued"
    ? extractCuits(t.counterparty)[0]
    : extractCuits(`${t.description} ${t.counterparty ?? ""}`)[0];

export function runRetentions(pool: Txn[], rejected: RejectedPairs): StepResult {
  const retentions = pool.filter((t) => t.source === "retention");
  const deposits = pool
    .filter((t) => t.source === "bank" && Number(t.amount) > 0)
    .sort((a, b) => a.date.getTime() - b.date.getTime() || a.id - b.id);
  const docs = pool.filter((t) => t.source === "afip_issued");

  const used = new Set<number>();
  const specs: MatchSpec[] = [];

  for (const deposit of deposits) {
    const cuit = cuitOf(deposit);
    if (!cuit) continue;
    const day = deposit.date.getTime();
    const rets = retentions.filter(
      (r) =>
        !used.has(r.id) &&
        cuitOf(r) === cuit &&
        day - r.date.getTime() >= 0 &&
        day - r.date.getTime() <= DAY_MS &&
        !rejected.has(pairKey(deposit.id, r.id)),
    );
    if (rets.length === 0) continue;

    const target = Number(deposit.amount) + rets.reduce((acc, r) => acc + Number(r.amount), 0);
    const candidates = docs
      .filter(
        (d) =>
          !used.has(d.id) &&
          cuitOf(d) === cuit &&
          d.date.getTime() >= day - DOC_LOOKBACK_DAYS * DAY_MS &&
          d.date.getTime() <= day + DOC_LOOKAHEAD_DAYS * DAY_MS &&
          !rejected.has(pairKey(deposit.id, d.id)),
      )
      .sort((a, b) => b.date.getTime() - a.date.getTime() || b.id - a.id)
      .slice(0, MAX_CANDIDATES);

    let solutions: Txn[][] = [];
    for (let size = 1; size <= Math.min(MAX_DOCS, candidates.length); size++) {
      combinations(candidates, size, (combo) => {
        const sum = combo.reduce((acc, d) => acc + Number(d.amount), 0);
        if (Math.abs(sum - target) <= TOLERANCE) solutions.push(combo);
      });
      if (solutions.length > 0) break;
    }
    if (solutions.length !== 1) {
      solutions = [];
      continue;
    }

    const combo = solutions[0];
    used.add(deposit.id);
    for (const r of rets) used.add(r.id);
    for (const d of combo) used.add(d.id);
    const retTotal = rets.reduce((acc, r) => acc + Number(r.amount), 0);
    specs.push({
      strategy: "cuit_group",
      status: "auto",
      confidence: 92,
      amountDiff: Math.abs(combo.reduce((acc, d) => acc + Number(d.amount), 0) - target),
      transactionIds: [deposit.id, ...rets.map((r) => r.id), ...combo.map((d) => d.id)],
      note: `Cobro de CUIT ${cuit}: depósito de ${Number(deposit.amount).toFixed(2)} más ${rets.length} retención${
        rets.length > 1 ? "es" : ""
      } de Ganancias por ${retTotal.toFixed(2)} cierran exacto con ${combo.length} comprobante${combo.length > 1 ? "s" : ""}.`,
    });
  }

  // Las retenciones que no se unieron no siguen a los demás pasos.
  return { specs, remaining: pool.filter((t) => !used.has(t.id) && t.source !== "retention") };
}
