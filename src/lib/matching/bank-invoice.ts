import { extractCuits } from "./cuit";
import { pairKey, type MatchSpec, type RejectedPairs, type StepResult, type Txn } from "./types";

/**
 * Pagos del banco contra UNA factura recibida que el cruce exacto y el de CUIT no
 * alcanzan:
 *
 * 1. `runCuitExactWide`: la transferencia trae el CUIT del proveedor, el importe
 *    es exactamente el de una factura de ese CUIT, pero la factura se emitió
 *    mucho después del pago (se pagó por adelantado). Díaz Yancomay: transferencia
 *    del 6/4 de $142.500 contra la factura del 6/5; Ubaldi: $1.510.000 el 21/8
 *    contra la factura del 14/9. El cruce por CUIT mira solo 7 días hacia
 *    adelante. Es seguro: mismo CUIT + mismo importe.
 *
 * 2. `runRoundExtra`: el pago es la factura MÁS un importe redondo, con los mismos
 *    centavos (Nosis: pago de $687.552,76 contra factura de $667.552,76, $20.000
 *    de más; $689.911,64 contra $686.911,64, $3.000 de más). Que los centavos
 *    coincidan es casi imposible por casualidad; el resto redondo suele ser otra
 *    deuda chica o un adelanto pagado en la misma transferencia. Solo sugerencia.
 *
 * En ambos casos el par tiene que ser único de los dos lados.
 */
const WIDE_DAYS_BEFORE = 120; // la factura se emitió hasta 120 días antes del pago
const WIDE_DAYS_AFTER = 60; // o hasta 60 días después (pago adelantado)
const WIDE_TOLERANCE = 1;

const EXTRA_MULTIPLE = 500;
const EXTRA_MIN = 500;
const EXTRA_MAX_SHARE = 0.15;
const EXTRA_CENTS_TOLERANCE = 0.01;
const EXTRA_DAYS_AFTER = 5; // la factura puede ser hasta 5 días posterior al pago
const EXTRA_DAYS_BEFORE = 40;
const DAY_MS = 24 * 60 * 60 * 1000;

function uniquePairs<T extends { bank: Txn; inv: Txn }>(pairs: T[]): T[] {
  const bankCount = new Map<number, number>();
  const invCount = new Map<number, number>();
  for (const p of pairs) {
    bankCount.set(p.bank.id, (bankCount.get(p.bank.id) ?? 0) + 1);
    invCount.set(p.inv.id, (invCount.get(p.inv.id) ?? 0) + 1);
  }
  return pairs.filter((p) => bankCount.get(p.bank.id) === 1 && invCount.get(p.inv.id) === 1);
}

function split(pool: Txn[]) {
  return {
    payments: pool.filter((t) => t.source === "bank" && Number(t.amount) < 0),
    invoices: pool.filter((t) => t.source === "afip_received" && Number(t.amount) < 0),
  };
}

export function runCuitExactWide(pool: Txn[], rejected: RejectedPairs): StepResult {
  const { payments, invoices } = split(pool);
  const pairs: { bank: Txn; inv: Txn; diff: number }[] = [];

  for (const bank of payments) {
    const cuits = extractCuits(`${bank.description} ${bank.counterparty ?? ""}`);
    if (cuits.length === 0) continue;
    const amount = Math.abs(Number(bank.amount));
    for (const inv of invoices) {
      const invCuit = extractCuits(inv.counterparty)[0];
      if (!invCuit || !cuits.includes(invCuit)) continue;
      const diff = Math.abs(amount - Math.abs(Number(inv.amount)));
      if (diff > WIDE_TOLERANCE) continue;
      const days = (inv.date.getTime() - bank.date.getTime()) / DAY_MS;
      if (days < -WIDE_DAYS_BEFORE || days > WIDE_DAYS_AFTER) continue;
      if (rejected.has(pairKey(bank.id, inv.id))) continue;
      pairs.push({ bank, inv, diff });
    }
  }

  const used = new Set<number>();
  const specs: MatchSpec[] = [];
  for (const p of uniquePairs(pairs)) {
    used.add(p.bank.id);
    used.add(p.inv.id);
    specs.push({
      strategy: "exact_1to1",
      status: "auto",
      confidence: 88,
      amountDiff: p.diff,
      transactionIds: [p.bank.id, p.inv.id],
      note: "Transferencia con el CUIT del proveedor e importe exacto de su factura, emitida bastante después del pago (pago adelantado).",
    });
  }
  return { specs, remaining: pool.filter((t) => !used.has(t.id)) };
}

export function runRoundExtra(pool: Txn[], rejected: RejectedPairs): StepResult {
  const { payments, invoices } = split(pool);
  const pairs: { bank: Txn; inv: Txn; extra: number }[] = [];

  for (const bank of payments) {
    const amount = Math.abs(Number(bank.amount));
    for (const inv of invoices) {
      const total = Math.abs(Number(inv.amount));
      const extra = amount - total;
      if (extra < EXTRA_MIN || extra > total * EXTRA_MAX_SHARE) continue;
      const offset = extra % EXTRA_MULTIPLE;
      if (Math.min(offset, EXTRA_MULTIPLE - offset) > EXTRA_CENTS_TOLERANCE) continue;
      const days = (inv.date.getTime() - bank.date.getTime()) / DAY_MS;
      if (days > EXTRA_DAYS_AFTER || days < -EXTRA_DAYS_BEFORE) continue;
      if (rejected.has(pairKey(bank.id, inv.id))) continue;
      // Una transferencia que ya nombra a OTRO proveedor no es de esta factura.
      const bankCuits = extractCuits(`${bank.description} ${bank.counterparty ?? ""}`);
      const invCuit = extractCuits(inv.counterparty)[0];
      if (bankCuits.length > 0 && (!invCuit || !bankCuits.includes(invCuit))) continue;
      pairs.push({ bank, inv, extra });
    }
  }

  const used = new Set<number>();
  const specs: MatchSpec[] = [];
  for (const p of uniquePairs(pairs)) {
    used.add(p.bank.id);
    used.add(p.inv.id);
    specs.push({
      strategy: "fuzzy",
      status: "pending",
      confidence: 75,
      amountDiff: p.extra,
      transactionIds: [p.bank.id, p.inv.id],
      note: `Sugerencia automática — el pago supera a la factura en ${p.extra.toFixed(2)}, un importe redondo, y los centavos coinciden: probable factura más otra deuda chica o adelanto en la misma transferencia. Única candidata. Revisar.`,
    });
  }
  return { specs, remaining: pool.filter((t) => !used.has(t.id)) };
}
