import type { mlPurchaseItems } from "@/db/schema";
import { pairKey, type MatchSpec, type RejectedPairs, type StepResult, type Txn } from "./types";

/**
 * Compras de MercadoLibre (reporte "Compras", ver `ml_purchase_items`) como
 * puente entre la factura del vendedor y el consumo de tarjeta. Por su cuenta
 * el motor no los une porque los importes no coinciden:
 *
 * - Cupones y descuentos: la factura sale por el precio de la publicación y la
 *   tarjeta cobra menos (Aquahome: factura $425.337,61, MERPAGO*AQUAHOME
 *   $412.894,02; Asus: $825.199 contra MERPAGO*ESPACIOELECTR $781.199).
 * - Un cargo por varios vendedores de la misma compra (Fernet + bolsas + vasos:
 *   tres facturas, un solo MERPAGO*MERCADOLIBRE de $172.094,76).
 * - Cuotas con recargo: el precio de MercadoLibre incluye la financiación y la
 *   factura del vendedor no (billetera Victorinox: 6 cuotas de $38.673,63 =
 *   $232.041,79 contra la factura de Tío Musa por $212.062,55, mismo día).
 *
 * El reporte trae, por compra, cuánto se le pagó a cada vendedor ("Precio
 * total") y la fecha exacta: con eso la factura se identifica al centavo y el
 * cargo de tarjeta por fecha + importe cercano. Nunca usa el nombre del
 * vendedor (el reporte no lo trae).
 */

type MlItem = typeof mlPurchaseItems.$inferSelect;

/** Lo que se le pagó a un vendedor dentro de una compra. */
export type MlPack = { key: string; total: number; shipping: number; products: string[] };
export type MlPurchase = { purchaseId: string; date: Date; packs: MlPack[] };

/** Un consumo de tarjeta: una fila, o todas las cuotas cargadas de una misma compra. */
export type CardUnit = { rows: Txn[]; amount: number; count: number; date: Date };

export type MlInvoiceLink = { inv: Txn; exact: boolean };
export type MlChargeLink = { unit: CardUnit; packKeys: string[]; target: number };
export type MlPurchaseLinks = {
  purchase: MlPurchase;
  invoices: Map<string, MlInvoiceLink>;
  charges: MlChargeLink[];
};

const DAY_MS = 24 * 60 * 60 * 1000;
// La factura llega el día de la compra o con la entrega; el cargo, el mismo día o el siguiente.
const INVOICE_DAYS_BEFORE = 3;
const INVOICE_DAYS_AFTER = 20;
const CHARGE_DAYS_BEFORE = 1;
const CHARGE_DAYS_AFTER = 3;
// Hasta 15 % de descuento entre el precio de MercadoLibre y lo cobrado o lo facturado.
const MIN_RATIO = 0.85;
// Las cuotas pueden traer recargo por encima del precio publicado.
const FINANCED_MAX_RATIO = 1.12;

const ML_CHARGE = /MERPAGO|MERCADO ?PAGO|MERCADOLIB/i;

export function groupMlItems(items: MlItem[]): MlPurchase[] {
  const byPurchase = new Map<string, { date: Date; packs: Map<string, MlPack> }>();
  for (const it of items) {
    const p = byPurchase.get(it.purchaseId) ?? { date: it.date, packs: new Map<string, MlPack>() };
    byPurchase.set(it.purchaseId, p);
    const total = Number(it.packTotal);
    const key = `${it.purchaseId}|${total.toFixed(2)}`;
    const pack = p.packs.get(key) ?? { key, total, shipping: 0, products: [] };
    pack.shipping = Math.max(pack.shipping, Number(it.shipping));
    pack.products.push(it.quantity > 1 ? `${it.quantity} x ${it.product}` : it.product);
    p.packs.set(key, pack);
  }
  return [...byPurchase.entries()]
    .map(([purchaseId, p]) => ({ purchaseId, date: p.date, packs: [...p.packs.values()] }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

function installmentCount(raw: unknown): number {
  if (!raw || typeof raw !== "object") return 1;
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(String((raw as Record<string, unknown>).cuotas ?? ""));
  const n = m ? Number(m[2]) : 1;
  return n >= 2 && n <= 24 ? n : 1;
}

export function isMlCharge(t: Txn): boolean {
  return t.source === "card" && Number(t.amount) < 0 && ML_CHARGE.test(t.description);
}

/** Las cuotas de una compra aparecen en cada resumen mensual con la fecha original: se juntan. */
export function cardUnits(cards: Txn[]): CardUnit[] {
  const units: CardUnit[] = [];
  const byInstallment = new Map<string, CardUnit>();
  for (const t of cards) {
    const count = installmentCount(t.raw);
    if (count === 1) {
      units.push({ rows: [t], amount: Math.abs(Number(t.amount)), count, date: t.date });
      continue;
    }
    const raw = t.raw as Record<string, unknown>;
    const key = `${raw.cardNumber ?? ""}|${raw.comprobante || t.description}|${t.date.toISOString().slice(0, 10)}|${count}`;
    const unit = byInstallment.get(key);
    if (unit) unit.rows.push(t);
    else {
      const u = { rows: [t], amount: 0, count, date: t.date };
      byInstallment.set(key, u);
      units.push(u);
    }
  }
  for (const u of byInstallment.values()) {
    u.amount = (u.rows.reduce((acc, r) => acc + Math.abs(Number(r.amount)), 0) / u.rows.length) * u.count;
  }
  return units;
}

// Con más vendedores en una compra solo se prueban de a uno y todos juntos.
const MAX_PACKS_FOR_SUBSETS = 5;

function packSubsets(packs: MlPack[]): MlPack[][] {
  if (packs.length > MAX_PACKS_FOR_SUBSETS) return [...packs.map((p) => [p]), packs];
  const subsets: MlPack[][] = [];
  for (let mask = 1; mask < 1 << packs.length; mask++) subsets.push(packs.filter((_, i) => mask & (1 << i)));
  return subsets;
}

const daysFrom = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / DAY_MS);

/**
 * Une cada compra con sus facturas (una por vendedor) y con su(s) cargo(s) de
 * tarjeta. Las asignaciones se hacen en orden de mejor coincidencia sobre todas
 * las compras a la vez, para que dos compras del mismo día no se roben los cargos.
 */
export function linkMercadoLibre(purchases: MlPurchase[], invoices: Txn[], cards: Txn[]): MlPurchaseLinks[] {
  const result = purchases.map((purchase) => ({
    purchase,
    invoices: new Map<string, MlInvoiceLink>(),
    charges: [] as MlChargeLink[],
  }));

  // 1) Facturas: al centavo (o con el envío sumado); si no, una factura algo menor el mismo día.
  type InvCand = { idx: number; pack: MlPack; inv: Txn; exact: boolean; days: number; diff: number };
  const invCands: InvCand[] = [];
  result.forEach(({ purchase }, idx) => {
    for (const pack of purchase.packs) {
      for (const inv of invoices) {
        const amount = Math.abs(Number(inv.amount));
        const days = daysFrom(purchase.date, inv.date);
        const diff = Math.min(Math.abs(amount - pack.total), Math.abs(amount - pack.total - pack.shipping));
        if (diff <= 1 && days >= -INVOICE_DAYS_BEFORE && days <= INVOICE_DAYS_AFTER) {
          invCands.push({ idx, pack, inv, exact: true, days, diff });
        } else if (amount < pack.total && amount / pack.total >= MIN_RATIO && days >= -CHARGE_DAYS_BEFORE && days <= CHARGE_DAYS_AFTER) {
          invCands.push({ idx, pack, inv, exact: false, days, diff: pack.total - amount });
        }
      }
    }
  });
  invCands.sort(
    (a, b) => Number(b.exact) - Number(a.exact) || Math.abs(a.days) - Math.abs(b.days) || a.diff - b.diff || a.inv.id - b.inv.id,
  );
  const usedInv = new Set<number>();
  for (const c of invCands) {
    const links = result[c.idx].invoices;
    if (usedInv.has(c.inv.id) || links.has(c.pack.key)) continue;
    usedInv.add(c.inv.id);
    links.set(c.pack.key, { inv: c.inv, exact: c.exact });
  }

  // 2) Cargos: por vendedor o por la compra entera, igual o algo menor (descuento); en cuotas, también algo mayor.
  type ChargeCand = { idx: number; unit: CardUnit; packKeys: string[]; target: number; rel: number };
  const units = cardUnits(cards.filter(isMlCharge));
  const chargeCands: ChargeCand[] = [];
  result.forEach(({ purchase }, idx) => {
    // Cada vendedor, y cada combinación de vendedores de la compra: MercadoLibre a
    // veces cobra dos de tres vendedores juntos (Step + cartuchos en 4 cuotas de
    // 7PRODUCTOS) y el tercero aparte.
    const targets = packSubsets(purchase.packs).map((packs) => {
      const sum = packs.reduce((acc, p) => acc + p.total, 0);
      const ship = packs.reduce((acc, p) => acc + p.shipping, 0);
      return { packKeys: packs.map((p) => p.key), totals: [sum, sum + ship] };
    });
    for (const unit of units) {
      const days = daysFrom(purchase.date, unit.date);
      if (days < -CHARGE_DAYS_BEFORE || days > CHARGE_DAYS_AFTER) continue;
      const rounding = unit.count * 0.5 + 1;
      for (const t of targets) {
        for (const target of new Set(t.totals)) {
          const max = unit.count > 1 ? target * FINANCED_MAX_RATIO : target + rounding;
          if (unit.amount < target * MIN_RATIO || unit.amount > max) continue;
          const diff = Math.abs(unit.amount - target);
          chargeCands.push({ idx, unit, packKeys: t.packKeys, target, rel: diff <= rounding ? 0 : diff / target });
        }
      }
    }
  });
  chargeCands.sort((a, b) => a.rel - b.rel || a.packKeys.length - b.packKeys.length);
  const usedUnits = new Set<CardUnit>();
  const coveredPacks = new Set<string>();
  for (const c of chargeCands) {
    if (usedUnits.has(c.unit) || c.packKeys.some((k) => coveredPacks.has(k))) continue;
    usedUnits.add(c.unit);
    for (const k of c.packKeys) coveredPacks.add(k);
    result[c.idx].charges.push({ unit: c.unit, packKeys: c.packKeys, target: c.target });
  }

  // Una factura menor que el precio solo se acepta por el recargo de las cuotas: el
  // cargo tiene que ser en cuotas y cerrar con el precio de MercadoLibre. Si no, una
  // factura cualquiera del mismo día (combustible, otro proveedor) se colaría.
  for (const link of result) {
    for (const [key, inv] of link.invoices) {
      if (inv.exact) continue;
      const charge = link.charges.find((c) => c.packKeys.length === 1 && c.packKeys[0] === key);
      const financed =
        charge && charge.unit.count > 1 && Math.abs(charge.unit.amount - charge.target) <= charge.unit.count * 0.5 + 1;
      if (!financed) link.invoices.delete(key);
    }
  }

  return result;
}

const money = (n: number) => n.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (d: Date) => d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });

/** Explicación para la nota del match y para la página de compras. */
export function describeChargeLink(link: MlPurchaseLinks, charge: MlChargeLink): {
  invoices: Txn[];
  diff: number;
  complete: boolean;
  invoicesExact: boolean;
  exact: boolean;
  text: string;
} {
  const packs = link.purchase.packs.filter((p) => charge.packKeys.includes(p.key));
  const found = packs.map((p) => link.invoices.get(p.key)).filter((x): x is MlInvoiceLink => !!x);
  const invoiced = found.reduce((acc, f) => acc + Math.abs(Number(f.inv.amount)), 0);
  const diff = charge.unit.amount - invoiced;
  const complete = found.length === packs.length;
  const rounding = charge.unit.count * 0.5 + 1;
  const invoicesExact = found.every((f) => f.exact);
  const exact = complete && invoicesExact && Math.abs(diff) <= rounding;

  const parts = [
    `Compra de MercadoLibre N° ${link.purchase.purchaseId} del ${fmtDate(link.purchase.date)}: ${packs.flatMap((p) => p.products).join(" + ")}.`,
    charge.unit.count > 1
      ? `Se pagó en ${charge.unit.count} cuotas de ${money(charge.unit.amount / charge.unit.count)} (total ${money(charge.unit.amount)}).`
      : `Se pagó con un cargo de ${money(charge.unit.amount)}.`,
  ];
  if (packs.length > 1) parts.push(`Un solo cargo por ${packs.length} vendedores.`);
  if (complete && !exact) {
    parts.push(
      diff < 0
        ? `MercadoLibre cobró ${money(-diff)} menos que lo facturado (cupón o descuento).`
        : `MercadoLibre cobró ${money(diff)} más que lo facturado (recargo de financiación de las cuotas).`,
    );
  }
  const missing = packs.filter((p) => !link.invoices.has(p.key));
  if (missing.length > 0) parts.push(`Falta la factura de: ${missing.flatMap((p) => p.products).join(" + ")}.`);
  return { invoices: found.map((f) => f.inv), diff: Math.abs(diff), complete, invoicesExact, exact, text: parts.join(" ") };
}

/** Paso del motor: arma un match por cada cargo de tarjeta de una compra que tenga al menos una factura. */
export function runMercadoLibre(pool: Txn[], purchases: MlPurchase[], rejected: RejectedPairs): StepResult {
  if (purchases.length === 0) return { specs: [], remaining: pool };
  const invoices = pool.filter((t) => t.source === "afip_received" && Number(t.amount) < 0);
  const cards = pool.filter(isMlCharge);
  const links = linkMercadoLibre(purchases, invoices, cards);

  const used = new Set<number>();
  const specs: MatchSpec[] = [];
  for (const link of links) {
    for (const charge of link.charges) {
      const d = describeChargeLink(link, charge);
      if (d.invoices.length === 0) continue;
      const ids = [...charge.unit.rows.map((r) => r.id), ...d.invoices.map((i) => i.id)];
      if (ids.some((id) => used.has(id))) continue;
      if (charge.unit.rows.some((r) => d.invoices.some((i) => rejected.has(pairKey(r.id, i.id))))) continue;
      for (const id of ids) used.add(id);
      specs.push({
        strategy: d.exact ? "exact_1to1" : "fuzzy",
        status: d.exact ? "auto" : "pending",
        confidence: d.exact ? 95 : !d.invoicesExact ? 70 : d.complete ? 90 : 75,
        amountDiff: d.diff,
        transactionIds: ids,
        note: d.exact ? d.text : `Sugerencia automática — ${d.text}`,
      });
    }
  }
  return { specs, remaining: pool.filter((t) => !used.has(t.id)) };
}
