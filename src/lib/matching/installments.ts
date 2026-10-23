import { pairKey, type MatchSpec, type RejectedPairs, type StepResult, type Txn } from "./types";

/**
 * Compras en cuotas: la factura es por el TOTAL y el resumen de tarjeta trae una
 * fila por cuota (en cada resumen mensual, con la fecha de la compra original y
 * la leyenda "4/6" en `raw.cuotas`). Contra una sola cuota nunca cierra: hay que
 * multiplicarla por la cantidad de cuotas.
 *
 * Casos reales: Incopar Digital $2.188.800 = 6 cuotas de $364.800; Tomasi
 * Neumáticos $1.056.000 = 3 de $352.000; Trintihome 6 x $20.676,18 = $124.057,08
 * contra la factura de Prischuk por $124.054,04 (la diferencia es el redondeo a
 * centavos de cada cuota).
 *
 * - Las cuotas de una misma compra se reconocen por tarjeta + comprobante +
 *   comercio + fecha original.
 * - El total (cuota x cantidad) tiene que cerrar con la factura salvo el redondeo
 *   de centavos de las cuotas.
 * - La factura se emite cerca de la compra: unos días antes o hasta
 *   DAYS_AFTER después.
 * - Si el total puede ser de más de una factura (o al revés) no se adivina.
 * - Se unen las cuotas que todavía están libres; las que ya se cruzaron con el
 *   pago bancario de su resumen se quedan donde están.
 */
const DAYS_BEFORE = 5;
const DAYS_AFTER = 25;
const MIN_TOTAL = 10000;
const DAY_MS = 24 * 60 * 60 * 1000;

type Purchase = { rows: Txn[]; total: number; count: number; date: Date };

function parseInstallments(raw: unknown): { count: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const text = String((raw as Record<string, unknown>).cuotas ?? "");
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(text);
  if (!m) return null;
  const count = Number(m[2]);
  return count >= 2 && count <= 24 ? { count } : null;
}

export function runInstallments(pool: Txn[], rejected: RejectedPairs): StepResult {
  // Cuotas libres agrupadas por compra.
  const byPurchase = new Map<string, Purchase>();
  for (const t of pool) {
    if (t.source !== "card" || Number(t.amount) >= 0) continue;
    const inst = parseInstallments(t.raw);
    if (!inst) continue;
    const raw = t.raw as Record<string, unknown>;
    const voucher = String(raw.comprobante ?? "");
    if (!voucher) continue;
    const key = `${raw.cardNumber ?? ""}|${voucher}|${t.description}|${t.date.toISOString().slice(0, 10)}|${inst.count}`;
    const existing = byPurchase.get(key);
    if (existing) existing.rows.push(t);
    else byPurchase.set(key, { rows: [t], total: Math.abs(Number(t.amount)) * inst.count, count: inst.count, date: t.date });
  }

  const invoices = pool.filter((t) => t.source === "afip_received" && Number(t.amount) < 0);

  // Pares plausibles compra <-> factura; se aceptan solo los únicos de ambos lados.
  const pairs: { purchase: Purchase; inv: Txn; diff: number }[] = [];
  for (const purchase of byPurchase.values()) {
    if (purchase.total < MIN_TOTAL) continue;
    const tolerance = purchase.count * 0.5 + 1; // redondeo a centavos de cada cuota
    for (const inv of invoices) {
      const diff = Math.abs(purchase.total - Math.abs(Number(inv.amount)));
      if (diff > tolerance) continue;
      const days = (inv.date.getTime() - purchase.date.getTime()) / DAY_MS;
      if (days < -DAYS_BEFORE || days > DAYS_AFTER) continue;
      if (purchase.rows.some((r) => rejected.has(pairKey(r.id, inv.id)))) continue;
      pairs.push({ purchase, inv, diff });
    }
  }

  const purchaseCount = new Map<Purchase, number>();
  const invoiceCount = new Map<number, number>();
  for (const p of pairs) {
    purchaseCount.set(p.purchase, (purchaseCount.get(p.purchase) ?? 0) + 1);
    invoiceCount.set(p.inv.id, (invoiceCount.get(p.inv.id) ?? 0) + 1);
  }

  const used = new Set<number>();
  const specs: MatchSpec[] = [];
  for (const p of pairs) {
    if (purchaseCount.get(p.purchase) !== 1 || invoiceCount.get(p.inv.id) !== 1) continue;
    for (const r of p.purchase.rows) used.add(r.id);
    used.add(p.inv.id);
    const loaded = p.purchase.rows.length;
    specs.push({
      strategy: "exact_1to1",
      status: "auto",
      confidence: p.diff <= 1 ? 92 : 85,
      amountDiff: p.diff,
      transactionIds: [...p.purchase.rows.map((r) => r.id), p.inv.id],
      note: `Compra en ${p.purchase.count} cuotas de ${(p.purchase.total / p.purchase.count).toFixed(2)} (total ${p.purchase.total.toFixed(2)}) contra una factura por ese total — ${loaded} cuota${loaded > 1 ? "s" : ""} libre${loaded > 1 ? "s" : ""} unida${loaded > 1 ? "s" : ""}.`,
    });
  }

  return { specs, remaining: pool.filter((t) => !used.has(t.id)) };
}
