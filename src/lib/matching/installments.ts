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
 * - Las cuotas de una misma compra se reconocen por tarjeta + comprobante + fecha
 *   original + cantidad de cuotas. El nombre del comercio NO entra en la clave: el
 *   lector de PDF lo transcribe distinto de un resumen a otro ("ON CITY
 *   MARKETPLACE" / "ON CITY MARKETDIGITA") y partía una compra en dos.
 * - Primera pasada (se confirma sola): el total (cuota x cantidad) cierra con la
 *   factura salvo el redondeo de centavos. Si hay varias facturas del mismo
 *   importe (Incopar emitió dos de $2.188.800) se toma la más cercana en fecha
 *   siempre que le saque ventaja a la siguiente.
 * - Segunda pasada (solo sugerencia): cuando las cuotas llevan recargo de
 *   financiación el total es algo MAYOR que la factura (5 % en Fontova y
 *   7PRODUCTOS, 9 % en Sinteplast contra Palavecino). Se propone si es la única
 *   candidata de ambos lados, con fecha pegada.
 * - Se unen las cuotas que todavía están libres; las que ya se cruzaron con el
 *   pago bancario de su resumen se quedan donde están.
 */
const DAYS_BEFORE = 5;
const DAYS_AFTER = 25;
const MIN_TOTAL = 10000;
const NEAREST_MARGIN_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

// Recargo por financiación: el total de las cuotas supera a la factura entre 0,5 % y 12 %.
const FINANCED_MIN_TOTAL = 50000;
const FINANCED_MIN_RATIO = 1.005;
const FINANCED_MAX_RATIO = 1.12;
const FINANCED_DAYS_BEFORE = 3;
const FINANCED_DAYS_AFTER = 10;

type Purchase = { rows: Txn[]; total: number; count: number; date: Date };
type Pair = { purchase: Purchase; inv: Txn; diff: number; days: number };

function parseInstallments(raw: unknown): { count: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const text = String((raw as Record<string, unknown>).cuotas ?? "");
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(text);
  if (!m) return null;
  const count = Number(m[2]);
  return count >= 2 && count <= 24 ? { count } : null;
}

function groupPurchases(pool: Txn[]): Purchase[] {
  const byPurchase = new Map<string, Purchase>();
  for (const t of pool) {
    if (t.source !== "card" || Number(t.amount) >= 0) continue;
    const inst = parseInstallments(t.raw);
    if (!inst) continue;
    const raw = t.raw as Record<string, unknown>;
    const voucher = String(raw.comprobante ?? "");
    if (!voucher) continue;
    const key = `${raw.cardNumber ?? ""}|${voucher}|${t.date.toISOString().slice(0, 10)}|${inst.count}`;
    const existing = byPurchase.get(key);
    if (existing) existing.rows.push(t);
    else byPurchase.set(key, { rows: [t], total: 0, count: inst.count, date: t.date });
  }
  const purchases = [...byPurchase.values()];
  for (const p of purchases) {
    // La primera cuota suele absorber el redondeo: se promedian las que hay.
    const mean = p.rows.reduce((acc, r) => acc + Math.abs(Number(r.amount)), 0) / p.rows.length;
    p.total = mean * p.count;
  }
  return purchases;
}

/** Se queda con los pares únicos de ambos lados. */
function uniquePairs(pairs: Pair[]): Pair[] {
  const purchaseCount = new Map<Purchase, number>();
  const invoiceCount = new Map<number, number>();
  for (const p of pairs) {
    purchaseCount.set(p.purchase, (purchaseCount.get(p.purchase) ?? 0) + 1);
    invoiceCount.set(p.inv.id, (invoiceCount.get(p.inv.id) ?? 0) + 1);
  }
  return pairs.filter((p) => purchaseCount.get(p.purchase) === 1 && invoiceCount.get(p.inv.id) === 1);
}

export function runInstallments(pool: Txn[], rejected: RejectedPairs): StepResult {
  const purchases = groupPurchases(pool).filter((p) => p.total >= MIN_TOTAL);
  const invoices = pool.filter((t) => t.source === "afip_received" && Number(t.amount) < 0);
  const daysBetween = (purchase: Purchase, inv: Txn) => (inv.date.getTime() - purchase.date.getTime()) / DAY_MS;
  const isRejected = (purchase: Purchase, inv: Txn) => purchase.rows.some((r) => rejected.has(pairKey(r.id, inv.id)));

  const used = new Set<number>();
  const specs: MatchSpec[] = [];
  const take = (p: Pair, status: "auto" | "pending", confidence: number, note: string) => {
    for (const r of p.purchase.rows) used.add(r.id);
    used.add(p.inv.id);
    specs.push({
      strategy: "exact_1to1",
      status,
      confidence,
      amountDiff: p.diff,
      transactionIds: [...p.purchase.rows.map((r) => r.id), p.inv.id],
      note,
    });
  };
  const loadedText = (n: number) => `${n} cuota${n > 1 ? "s" : ""} libre${n > 1 ? "s" : ""}`;

  // Primera pasada: el total cierra con la factura.
  const exact: Pair[] = [];
  for (const purchase of purchases) {
    const tolerance = purchase.count * 0.5 + 1; // redondeo a centavos de cada cuota
    const candidates: Pair[] = [];
    for (const inv of invoices) {
      const diff = Math.abs(purchase.total - Math.abs(Number(inv.amount)));
      if (diff > tolerance) continue;
      const days = daysBetween(purchase, inv);
      if (days < -DAYS_BEFORE || days > DAYS_AFTER) continue;
      if (isRejected(purchase, inv)) continue;
      candidates.push({ purchase, inv, diff, days });
    }
    if (candidates.length === 0) continue;
    // Varias facturas del mismo importe: la más cercana en fecha, si le saca ventaja a la siguiente.
    candidates.sort((a, b) => Math.abs(a.days) - Math.abs(b.days));
    if (candidates.length > 1 && Math.abs(candidates[1].days) - Math.abs(candidates[0].days) < NEAREST_MARGIN_DAYS) continue;
    exact.push(candidates[0]);
  }
  for (const p of uniquePairs(exact)) {
    take(
      p,
      "auto",
      p.diff <= 1 ? 92 : 85,
      `Compra en ${p.purchase.count} cuotas de ${(p.purchase.total / p.purchase.count).toFixed(2)} (total ${p.purchase.total.toFixed(2)}) contra una factura por ese total — ${loadedText(p.purchase.rows.length)} unida${p.purchase.rows.length > 1 ? "s" : ""}.`,
    );
  }

  // Segunda pasada: cuotas con recargo de financiación, solo como sugerencia.
  const financed: Pair[] = [];
  for (const purchase of purchases) {
    if (purchase.rows.some((r) => used.has(r.id)) || purchase.total < FINANCED_MIN_TOTAL) continue;
    for (const inv of invoices) {
      if (used.has(inv.id)) continue;
      const amount = Math.abs(Number(inv.amount));
      const ratio = purchase.total / amount;
      if (ratio < FINANCED_MIN_RATIO || ratio > FINANCED_MAX_RATIO) continue;
      const days = daysBetween(purchase, inv);
      if (days < -FINANCED_DAYS_BEFORE || days > FINANCED_DAYS_AFTER) continue;
      if (isRejected(purchase, inv)) continue;
      financed.push({ purchase, inv, diff: purchase.total - amount, days });
    }
  }
  for (const p of uniquePairs(financed)) {
    const pct = (p.diff / Math.abs(Number(p.inv.amount))) * 100;
    take(
      p,
      "pending",
      55,
      `Sugerencia automática — compra en ${p.purchase.count} cuotas (total ${p.purchase.total.toFixed(2)}) que supera a la factura en ${p.diff.toFixed(2)} (${pct.toFixed(1)} %): probable recargo de financiación. Es la única factura candidata (${loadedText(p.purchase.rows.length)}). Revisar.`,
    );
  }

  return { specs, remaining: pool.filter((t) => !used.has(t.id)) };
}
