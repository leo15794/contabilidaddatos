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
 *
 * Ojo: el "Precio total" agrupa lo que se despachó junto, no a un vendedor. Una
 * misma caja trae productos de varios vendedores, cada uno con su factura: las
 * barritas del 09/12 ($170.560, un solo cargo) son 5 x $15.800 de Integra y
 * 5 x $18.312 de Bottazzini. Por eso la factura también se busca contra los
 * productos sueltos, y puede llegar meses después de la compra.
 */

type MlItem = typeof mlPurchaseItems.$inferSelect;

/** Lo que se le pagó a un vendedor dentro de una compra. */
export type MlItemLine = { label: string; amount: number };
export type MlPack = { key: string; total: number; shipping: number; products: string[]; items: MlItemLine[] };
export type MlPurchase = { purchaseId: string; date: Date; packs: MlPack[] };

/** Un consumo de tarjeta: una fila, o todas las cuotas cargadas de una misma compra. */
export type CardUnit = { rows: Txn[]; amount: number; count: number; date: Date };

/**
 * `match`: al centavo, emitida por el comercio del cargo, o menor por el recargo de las cuotas.
 * `items`: qué productos del paquete cubre. `late`: llegó bastante después de la compra.
 */
export type MlInvoiceLink = { inv: Txn; exact: boolean; match: "exact" | "name" | "financed"; items: number[]; late: boolean };
export type MlChargeLink = { unit: CardUnit; packKeys: string[]; target: number };
export type MlPurchaseLinks = {
  purchase: MlPurchase;
  invoices: Map<string, MlInvoiceLink[]>;
  charges: MlChargeLink[];
};

const DAY_MS = 24 * 60 * 60 * 1000;
// La factura llega el día de la compra o con la entrega; el cargo, el mismo día o el siguiente.
const INVOICE_DAYS_BEFORE = 3;
const INVOICE_DAYS_AFTER = 20;
// Al centavo se acepta aunque llegue meses después (Martcomp facturó a los 97 días),
// pero cuantos más productos suma, más fácil es que cierre de casualidad.
const LATE_INVOICE_DAYS: Record<number, number> = { 1: 120, 2: INVOICE_DAYS_AFTER };
const MANY_ITEMS_DAYS = 5;
const MAX_ITEMS_FOR_SUBSETS = 10;
const CHARGE_DAYS_BEFORE = 1;
const CHARGE_DAYS_AFTER = 3;
// Hasta 15 % de descuento entre el precio de MercadoLibre y lo cobrado o lo facturado.
const MIN_RATIO = 0.85;
// Las cuotas pueden traer recargo por encima del precio publicado.
const FINANCED_MAX_RATIO = 1.12;

const ML_CHARGE = /MERPAGO|MERCADO ?PAGO|MERCADOLIB/i;

export function groupMlItems(items: MlItem[]): MlPurchase[] {
  const byPurchase = new Map<string, { date: Date; groups: Map<string, MlItem[]> }>();
  for (const it of items) {
    const p = byPurchase.get(it.purchaseId) ?? { date: it.date, groups: new Map<string, MlItem[]>() };
    byPurchase.set(it.purchaseId, p);
    const key = `${it.purchaseId}|${Number(it.packTotal).toFixed(2)}`;
    p.groups.set(key, [...(p.groups.get(key) ?? []), it]);
  }

  const label = (it: MlItem) => (it.quantity > 1 ? `${it.quantity} x ${it.product}` : it.product);
  const line = (it: MlItem): MlItemLine => ({ label: label(it), amount: it.quantity * Number(it.unitPrice) });
  return [...byPurchase.entries()]
    .map(([purchaseId, p]) => {
      const packs: MlPack[] = [];
      for (const [key, rows] of p.groups) {
        const total = Number(rows[0].packTotal);
        const shipping = Math.max(...rows.map((r) => Number(r.shipping)));
        // Dos vendedores con el mismo total en una compra (dos bafles, dos cajas de
        // barritas de $142.000 con una factura cada una): cada producto ya vale el
        // total por sí solo, así que son vendedores distintos y no uno.
        const each = (r: MlItem) => r.quantity * Number(r.unitPrice) + Number(r.taxes);
        if (rows.length > 1 && rows.every((r) => Math.abs(each(r) - total) <= Math.max(1, total * 0.01))) {
          rows.forEach((r, i) => packs.push({ key: `${key}|${i}`, total, shipping, products: [label(r)], items: [line(r)] }));
        } else {
          packs.push({ key, total, shipping, products: rows.map(label), items: rows.map(line) });
        }
      }
      return { purchaseId, date: p.date, packs };
    })
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

// Palabras que el resumen de tarjeta no imprime: la razón social sin el tipo de sociedad.
const LEGAL_SUFFIX = /\b(SOCIEDAD ANONIMA|S\.?\s?A\.?\s?I\.?\s?C\.?|S\.?\s?R\.?\s?L\.?|S\.?\s?A\.?\s?S\.?|S\.?\s?A\.?)(?=\s|$|\W)/g;
const compact = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
// Cargos que no dicen a qué vendedor se le pagó.
const GENERIC_MERCHANTS = new Set(["MERCADOLIBRE", "MERCADOLIB", "MERCADOPAGO", "COMPRAR"]);

/** Comercio del cargo: lo que sigue a "MERPAGO*" (truncado por el resumen, ej. "ESPACIOELECTR"). */
function merchantOf(unit: CardUnit): string {
  const desc = unit.rows[0].description;
  const m = compact(desc.includes("*") ? desc.slice(desc.indexOf("*") + 1) : "");
  return m.length >= 5 && !GENERIC_MERCHANTS.has(m) ? m : "";
}

/** Razón social de la factura recibida, sin CUIT ni tipo de sociedad. */
function issuerOf(inv: Txn): string {
  const name = (inv.counterparty ?? "").split(" - ").slice(1).join(" ") || inv.description.split("·").pop() || "";
  return compact(name.toUpperCase().replace(LEGAL_SUFFIX, " "));
}

function sameMerchant(unit: CardUnit, inv: Txn): boolean {
  const m = merchantOf(unit);
  const i = issuerOf(inv);
  return m !== "" && i.length >= 5 && (i.startsWith(m) || m.startsWith(i));
}

/** Combinaciones de productos de un paquete, sin contar el paquete entero. */
function itemSubsets(pack: MlPack): { items: number[]; sum: number }[] {
  const n = pack.items.length;
  if (n < 2 || n > MAX_ITEMS_FOR_SUBSETS) return [];
  const subsets: { items: number[]; sum: number }[] = [];
  for (let mask = 1; mask < (1 << n) - 1; mask++) {
    const items = pack.items.flatMap((_, i) => (mask & (1 << i) ? [i] : []));
    subsets.push({ items, sum: items.reduce((acc, i) => acc + pack.items[i].amount, 0) });
  }
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
    invoices: new Map<string, MlInvoiceLink[]>(),
    charges: [] as MlChargeLink[],
  }));

  const units = cardUnits(cards.filter(isMlCharge));
  const nearPurchase = (purchase: MlPurchase, unit: CardUnit) => {
    const days = daysFrom(purchase.date, unit.date);
    return days >= -CHARGE_DAYS_BEFORE && days <= CHARGE_DAYS_AFTER;
  };
  // Una factura cuyo emisor es el comercio de un cargo de esos días (TIO MUSA y
  // MERPAGO*TIOMUSA) es de ese cargo: no se la puede llevar otra compra solo por importe.
  const namedByCharge = (inv: Txn) =>
    units.some((u) => sameMerchant(u, inv) && Math.abs(daysFrom(u.date, inv.date)) <= INVOICE_DAYS_AFTER);

  // 1) Facturas, de mejor a peor evidencia: al centavo contra el paquete entero (o
  // sin el envío, que el "Precio total" ya incluye y puede facturar MercadoLibre
  // aparte) o contra algunos de sus productos; emitida por
  // el mismo comercio que cobró en la tarjeta, con importe parecido; o algo menor
  // el mismo día (recargo de cuotas, se confirma más abajo).
  type InvCand = { idx: number; pack: MlPack; inv: Txn; match: MlInvoiceLink["match"]; days: number; diff: number; items: number[] };
  const RANK = { exact: 0, name: 1, financed: 2 } as const;
  const invCands: InvCand[] = [];
  result.forEach(({ purchase }, idx) => {
    const merchants = units.filter((u) => nearPurchase(purchase, u));
    for (const pack of purchase.packs) {
      const allItems = pack.items.map((_, i) => i);
      const subsets = itemSubsets(pack);
      for (const inv of invoices) {
        const amount = Math.abs(Number(inv.amount));
        const days = daysFrom(purchase.date, inv.date);
        const inWindow = days >= -INVOICE_DAYS_BEFORE && days <= INVOICE_DAYS_AFTER;
        const diff = Math.min(Math.abs(amount - pack.total), Math.abs(amount - (pack.total - pack.shipping)));
        const ratio = amount / pack.total;
        if (diff <= 1 && days >= -INVOICE_DAYS_BEFORE && days <= LATE_INVOICE_DAYS[1]) {
          invCands.push({ idx, pack, inv, match: "exact", days, diff, items: allItems });
          continue;
        }
        for (const s of subsets) {
          const maxDays = LATE_INVOICE_DAYS[s.items.length] ?? MANY_ITEMS_DAYS;
          if (Math.abs(amount - s.sum) <= 1 && days >= -INVOICE_DAYS_BEFORE && days <= maxDays) {
            invCands.push({ idx, pack, inv, match: "exact", days, diff: Math.abs(amount - s.sum), items: s.items });
          }
        }
        // El cargo de ese comercio tiene que poder ser el de este vendedor; entre
        // dos compras del mismo día gana la de precio más cercano al cargo.
        const unitDiffs =
          inWindow && ratio >= MIN_RATIO && ratio <= 2 - MIN_RATIO
            ? merchants
                .filter((u) => sameMerchant(u, inv) && u.amount >= pack.total * MIN_RATIO && u.amount <= pack.total * FINANCED_MAX_RATIO)
                .map((u) => Math.abs(u.amount - pack.total))
            : [];
        if (unitDiffs.length > 0) {
          invCands.push({ idx, pack, inv, match: "name", days, diff: Math.min(...unitDiffs), items: allItems });
        } else if (ratio < 1 && ratio >= MIN_RATIO && days >= -CHARGE_DAYS_BEFORE && days <= CHARGE_DAYS_AFTER && !namedByCharge(inv)) {
          invCands.push({ idx, pack, inv, match: "financed", days, diff: pack.total - amount, items: allItems });
        }
      }
    }
  });
  invCands.sort(
    (a, b) =>
      RANK[a.match] - RANK[b.match] ||
      (a.match === "name" ? a.diff - b.diff : 0) ||
      Number(b.items.length === b.pack.items.length) - Number(a.items.length === a.pack.items.length) ||
      a.items.length - b.items.length ||
      Math.abs(a.days) - Math.abs(b.days) ||
      a.diff - b.diff ||
      a.inv.id - b.inv.id,
  );
  const usedInv = new Set<number>();
  for (const c of invCands) {
    const links = result[c.idx].invoices.get(c.pack.key) ?? [];
    const taken = new Set(links.flatMap((l) => l.items));
    if (usedInv.has(c.inv.id) || c.items.some((i) => taken.has(i))) continue;
    usedInv.add(c.inv.id);
    const late = c.days > INVOICE_DAYS_AFTER;
    result[c.idx].invoices.set(c.pack.key, [...links, { inv: c.inv, exact: c.match === "exact", match: c.match, items: c.items, late }]);
  }

  // 2) Cargos: por vendedor o por la compra entera, igual o algo menor (descuento); en cuotas, también algo mayor.
  // A igual diferencia gana el cargo del mismo comercio que emitió la factura.
  type ChargeCand = { idx: number; unit: CardUnit; packKeys: string[]; target: number; rel: number };
  const chargeCands: ChargeCand[] = [];
  result.forEach(({ purchase }, idx) => {
    // Cada vendedor, y cada combinación de vendedores de la compra: MercadoLibre a
    // veces cobra dos de tres vendedores juntos (Step + cartuchos en 4 cuotas de
    // 7PRODUCTOS) y el tercero aparte.
    const targets = packSubsets(purchase.packs).map((packs) => {
      const sum = packs.reduce((acc, p) => acc + p.total, 0);
      const ship = packs.reduce((acc, p) => acc + p.shipping, 0);
      return { packKeys: packs.map((p) => p.key), totals: [sum, sum - ship] };
    });
    const invoicesOf = (keys: string[]) =>
      keys.flatMap((k) => (result[idx].invoices.get(k) ?? []).map((l) => l.inv));
    for (const unit of units) {
      if (!nearPurchase(purchase, unit)) continue;
      const rounding = unit.count * 0.5 + 1;
      for (const t of targets) {
        const named = invoicesOf(t.packKeys).some((inv) => sameMerchant(unit, inv));
        for (const target of new Set(t.totals)) {
          const max = unit.count > 1 ? target * FINANCED_MAX_RATIO : target + rounding;
          if (unit.amount < target * MIN_RATIO || unit.amount > max) continue;
          const diff = Math.abs(unit.amount - target);
          const rel = diff <= rounding ? 0 : diff / target;
          chargeCands.push({ idx, unit, packKeys: t.packKeys, target, rel: named ? rel - 1 : rel });
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
  // La factura por nombre, en cambio, tiene que quedar con el cargo de ese mismo comercio.
  for (const link of result) {
    for (const [key, links] of link.invoices) {
      const charge = link.charges.find((c) => c.packKeys.includes(key));
      const kept = links.filter((inv) => {
        if (inv.match === "exact") return true;
        return inv.match === "name"
          ? !!charge && sameMerchant(charge.unit, inv.inv)
          : !!charge &&
              charge.packKeys.length === 1 &&
              charge.unit.count > 1 &&
              Math.abs(charge.unit.amount - charge.target) <= charge.unit.count * 0.5 + 1;
      });
      if (kept.length > 0) link.invoices.set(key, kept);
      else link.invoices.delete(key);
    }
  }

  // Cargos sueltos del mismo comercio ese día que completan la factura (Tío Musa
  // facturó $212.062,55 y cobró $196.999 + $5.130,55 por separado).
  for (const link of result) {
    for (const charge of link.charges) {
      if (charge.unit.count > 1) continue;
      const invoiced = charge.packKeys
        .flatMap((k) => link.invoices.get(k) ?? [])
        .reduce((acc, l) => acc + Math.abs(Number(l.inv.amount)), 0);
      if (invoiced === 0) continue;
      const extras = units.filter(
        (u) =>
          !usedUnits.has(u) &&
          u.count === 1 &&
          Math.abs(daysFrom(charge.unit.date, u.date)) <= 1 &&
          merchantOf(u) !== "" &&
          merchantOf(u) === merchantOf(charge.unit),
      );
      for (const extra of extras) {
        if (Math.abs(charge.unit.amount + extra.amount - invoiced) >= Math.abs(charge.unit.amount - invoiced)) continue;
        usedUnits.add(extra);
        charge.unit = { ...charge.unit, rows: [...charge.unit.rows, ...extra.rows], amount: charge.unit.amount + extra.amount };
      }
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
  /** Alguna factura se tomó solo por ser algo menor el mismo día (recargo de cuotas): evidencia más floja. */
  financed: boolean;
  /** Alguna factura llegó bastante después de la compra: se pide revisarla aunque cierre al centavo. */
  late: boolean;
  exact: boolean;
  text: string;
} {
  const packs = link.purchase.packs.filter((p) => charge.packKeys.includes(p.key));
  const found = packs.flatMap((p) => link.invoices.get(p.key) ?? []);
  const invoiced = found.reduce((acc, f) => acc + Math.abs(Number(f.inv.amount)), 0);
  const diff = charge.unit.amount - invoiced;
  const uncovered = packs.flatMap((p) => {
    const covered = new Set((link.invoices.get(p.key) ?? []).flatMap((l) => l.items));
    return p.items.filter((_, i) => !covered.has(i)).map((it) => it.label);
  });
  const complete = uncovered.length === 0;
  const rounding = charge.unit.count * 0.5 + 1;
  const financed = found.some((f) => f.match === "financed");
  const late = found.some((f) => f.late);
  const exact = complete && !late && found.every((f) => f.exact) && Math.abs(diff) <= rounding;

  const { unit } = charge;
  const parts = [
    `Compra de MercadoLibre N° ${link.purchase.purchaseId} del ${fmtDate(link.purchase.date)}: ${packs.flatMap((p) => p.products).join(" + ")}.`,
    unit.count > 1
      ? `Se pagó en ${unit.count} cuotas de ${money(unit.amount / unit.count)} (total ${money(unit.amount)}).`
      : unit.rows.length > 1
        ? `Se pagó en ${unit.rows.length} cargos del mismo comercio: ${unit.rows.map((r) => money(Math.abs(Number(r.amount)))).join(" + ")} = ${money(unit.amount)}.`
        : `Se pagó con un cargo de ${money(unit.amount)}.`,
  ];
  if (found.length > 1) parts.push(`Un solo cargo por ${found.length} facturas.`);
  if (late) parts.push("Alguna factura se emitió bastante después de la compra.");
  if (found.some((f) => f.match === "name")) parts.push("La factura la emitió el mismo comercio que figura en la tarjeta.");
  if (complete && Math.abs(diff) > rounding) {
    parts.push(
      diff < 0
        ? `MercadoLibre cobró ${money(-diff)} menos que lo facturado (cupón o descuento).`
        : `MercadoLibre cobró ${money(diff)} más que lo facturado${unit.count > 1 ? " (recargo de financiación de las cuotas)" : ""}.`,
    );
  }
  if (uncovered.length > 0) parts.push(`Falta la factura de: ${uncovered.join(" + ")}.`);
  return { invoices: found.map((f) => f.inv), diff: Math.abs(diff), complete, financed, late, exact, text: parts.join(" ") };
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
        confidence: d.exact ? 95 : d.financed ? 70 : !d.complete ? 75 : d.late ? 85 : 90,
        amountDiff: d.diff,
        transactionIds: ids,
        note: d.exact ? d.text : `Sugerencia automática — ${d.text}`,
      });
    }
  }
  return { specs, remaining: pool.filter((t) => !used.has(t.id)) };
}
