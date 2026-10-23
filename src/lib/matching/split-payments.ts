import { extractCuits } from "./cuit";
import { pairKey, type MatchSpec, type RejectedPairs, type StepResult, type Txn } from "./types";

/**
 * Una factura recibida pagada en partes: DOS o TRES pagos del banco cuya suma
 * cierra la factura (al peso). Es el espejo de `payment-groups` (una
 * transferencia contra varias facturas), que no cubre este caso.
 *
 * Ejemplos reales: Nosis $630.456,92 = $17.767,96 + $612.688,96; Lorusso
 * $1.521.000 = $532.350 + $988.650; Nicola $147.210,22 = $143.648,63 +
 * $3.561,59 (mismo día, los dos con el CUIT en la descripción).
 *
 * Un pago entra como candidato solo si es de ESTE proveedor (trae su CUIT) o si
 * no dice a quién se pagó (transferencia sin beneficiario): un pago con nombre de
 * otro (ej. GOOGLE ARGENTINA) nunca. Sin eso, los débitos redondos de $5.000 y
 * $100.000 sumaban casi cualquier factura de ~$105.000.
 *
 * Siempre queda como sugerencia: dos pagos que suman justo una factura son una
 * señal fuerte, pero no hay un beneficiario que la confirme.
 */
const MAX_PAYMENTS = 3;
const DAYS_BEFORE = 15;
const DAYS_AFTER = 45;
const MAX_CANDIDATES = 24;
const AMOUNT_TOLERANCE = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

// Descripciones de transferencias que no nombran al beneficiario.
const NO_BENEFICIARY = /macronline|minorista|transf/i;

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

export function runSplitPayments(pool: Txn[], rejected: RejectedPairs): StepResult {
  const used = new Set<number>();
  const specs: MatchSpec[] = [];

  const payments = pool.filter((t) => t.source === "bank" && Number(t.amount) < 0);
  const invoices = pool
    .filter((t) => t.source === "afip_received" && Number(t.amount) < 0)
    .sort((a, b) => a.date.getTime() - b.date.getTime() || a.id - b.id);

  for (const inv of invoices) {
    const target = Math.abs(Number(inv.amount));
    const cuit = extractCuits(inv.counterparty)[0];
    if (!cuit || target < 1) continue;
    const t0 = inv.date.getTime();

    const withOwnCuit = new Set<number>();
    const candidates = payments
      .filter((p) => {
        if (used.has(p.id) || rejected.has(pairKey(inv.id, p.id))) return false;
        const amount = Math.abs(Number(p.amount));
        if (amount >= target) return false;
        const time = p.date.getTime();
        if (time < t0 - DAYS_BEFORE * DAY_MS || time > t0 + DAYS_AFTER * DAY_MS) return false;
        const text = `${p.description} ${p.counterparty ?? ""}`;
        const cuits = extractCuits(text);
        if (cuits.length > 0) {
          if (!cuits.includes(cuit)) return false;
          withOwnCuit.add(p.id);
          return true;
        }
        return NO_BENEFICIARY.test(text);
      })
      .sort((a, b) => Math.abs(a.date.getTime() - t0) - Math.abs(b.date.getTime() - t0))
      .slice(0, MAX_CANDIDATES);

    const solutions: Txn[][] = [];
    for (let size = 2; size <= Math.min(MAX_PAYMENTS, candidates.length); size++) {
      combinations(candidates, size, (combo) => {
        const sum = combo.reduce((acc, p) => acc + Math.abs(Number(p.amount)), 0);
        if (Math.abs(sum - target) > AMOUNT_TOLERANCE) return;
        // Tres pagos todos redondos suman cualquier cosa: tiene que haber algún importe "suelto".
        if (size === 3 && combo.every((p) => Math.abs(Number(p.amount)) % 1000 === 0)) return;
        solutions.push(combo);
      });
      if (solutions.length > 0) break; // la solución con menos pagos gana
    }

    // Si hay más de una forma de armarla no se adivina.
    if (solutions.length !== 1) continue;
    const combo = solutions[0];

    for (const p of combo) used.add(p.id);
    used.add(inv.id);
    const ownCuit = combo.some((p) => withOwnCuit.has(p.id));
    const allRound = combo.every((p) => Math.abs(Number(p.amount)) % 1000 === 0);
    const sum = combo.reduce((acc, p) => acc + Math.abs(Number(p.amount)), 0);

    specs.push({
      strategy: "payment_group",
      status: "pending",
      confidence: ownCuit && !allRound ? 85 : allRound ? 65 : 75,
      amountDiff: Math.abs(sum - target),
      transactionIds: [inv.id, ...combo.map((p) => p.id)],
      note: `Sugerencia automática — factura pagada en ${combo.length} partes: los pagos del banco suman ${sum.toFixed(2)}${
        ownCuit ? ", y al menos uno trae el CUIT del proveedor" : ", transferencias sin beneficiario"
      }${allRound ? ". Importes redondos: revisar que no sea casualidad" : ""}.`,
    });
  }

  return { specs, remaining: pool.filter((t) => !used.has(t.id)) };
}
