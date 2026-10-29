import { and, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { matchItems, matches, mlPurchaseItems, transactions } from "@/db/schema";
import type { MlPurchaseRow } from "./parsers/mercadolibre-csv";
import { groupMlItems, isMlCharge, linkMercadoLibre, type MlPack } from "./matching/mercadolibre";

/**
 * Guarda las filas del reporte. Un producto se identifica por orden + item:
 * volver a subir el mismo reporte (o uno que se solapa) no duplica nada.
 */
export async function saveMercadoLibreItems(filename: string, rows: MlPurchaseRow[]) {
  if (rows.length === 0) return { inserted: 0, skipped: 0 };
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const res = await db
      .insert(mlPurchaseItems)
      .values(
        chunk.map((r) => ({
          purchaseId: r.purchaseId,
          orderId: r.orderId,
          itemId: r.itemId,
          date: r.date,
          product: r.product,
          quantity: r.quantity,
          unitPrice: r.unitPrice.toFixed(2),
          packTotal: r.packTotal.toFixed(2),
          shipping: r.shipping.toFixed(2),
          taxes: r.taxes.toFixed(2),
          paymentMethod: r.paymentMethod,
          buyer: r.buyer,
          filename,
        })),
      )
      .onConflictDoNothing({ target: [mlPurchaseItems.orderId, mlPurchaseItems.itemId] })
      .returning({ id: mlPurchaseItems.id });
    inserted += res.length;
  }
  return { inserted, skipped: rows.length - inserted };
}

export type MlPackStatus = "conciliada" | "otro_pago" | "sugerida" | "sin_factura" | "sin_cargo" | "sin_datos";

export type MlPackView = {
  key: string;
  products: string[];
  total: number;
  status: MlPackStatus;
  invoice: { id: number; name: string; amount: number; date: Date } | null;
  charge: { description: string; amount: number; count: number; date: Date } | null;
};

export type MlPurchaseView = { purchaseId: string; date: Date; total: number; packs: MlPackView[] };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Cada compra con su factura y su cargo, buscados sobre TODOS los movimientos
 * (no solo los libres, como hace el motor), y el estado de conciliación real:
 * conciliada si factura y cargo están en el mismo match.
 */
export async function getMercadoLibrePurchases(): Promise<MlPurchaseView[]> {
  const purchases = groupMlItems(await db.select().from(mlPurchaseItems));
  if (purchases.length === 0) return [];

  const from = new Date(purchases[0].date.getTime() - 5 * DAY_MS);
  const to = new Date(purchases[purchases.length - 1].date.getTime() + 25 * DAY_MS);
  const txns = await db
    .select()
    .from(transactions)
    .where(
      and(
        inArray(transactions.source, ["card", "afip_received"]),
        gte(transactions.date, from),
        lte(transactions.date, to),
        sql`${transactions.amount} < 0`,
      ),
    );
  const invoices = txns.filter((t) => t.source === "afip_received");
  const cards = txns.filter(isMlCharge);
  const links = linkMercadoLibre(purchases, invoices, cards);

  // Matches vigentes de cada movimiento (sin contar el cruce del resumen contra el banco, que no concilia la factura).
  const ids = txns.map((t) => t.id);
  const memberships = ids.length
    ? await db
        .select({ txnId: matchItems.transactionId, matchId: matches.id, status: matches.status })
        .from(matchItems)
        .innerJoin(matches, eq(matches.id, matchItems.matchId))
        .where(and(inArray(matchItems.transactionId, ids), ne(matches.status, "rejected"), ne(matches.strategy, "card_statement_1toN")))
    : [];
  const matchesOf = new Map<number, { matchId: number; status: string }[]>();
  const rowsOf = new Map<number, number[]>();
  for (const m of memberships) {
    const list = matchesOf.get(m.txnId) ?? [];
    list.push(m);
    matchesOf.set(m.txnId, list);
    rowsOf.set(m.matchId, [...(rowsOf.get(m.matchId) ?? []), m.txnId]);
  }
  const txnById = new Map(txns.map((t) => [t.id, t]));

  return links.map((link) => {
    const packView = (pack: MlPack): MlPackView => {
      const inv = link.invoices.get(pack.key)?.inv ?? null;
      const charge = link.charges.find((c) => c.packKeys.includes(pack.key)) ?? null;
      const invMatches = inv ? matchesOf.get(inv.id) ?? [] : [];
      const shared = charge
        ? invMatches.find((m) => charge.unit.rows.some((r) => (matchesOf.get(r.id) ?? []).some((x) => x.matchId === m.matchId)))
        : undefined;

      // La factura ya está cruzada con un pago que no es el cargo de esta compra (ni
      // una copia del mismo cargo cargada desde otro resumen): probable cruce equivocado.
      const sameCharge = (id: number) => {
        const t = txnById.get(id);
        return (
          !!t &&
          t.source === "card" &&
          charge!.unit.rows.some(
            (r) => r.date.getTime() === t.date.getTime() && Math.abs(Number(r.amount) - Number(t.amount)) <= 0.05,
          )
        );
      };
      const decided = invMatches.filter((m) => m.status !== "pending");

      let status: MlPackStatus;
      if (inv && shared) status = shared.status === "pending" ? "sugerida" : "conciliada";
      else if (inv && charge && decided.length > 0 && !decided.some((m) => (rowsOf.get(m.matchId) ?? []).some(sameCharge)))
        status = "otro_pago";
      else if (inv && decided.length > 0) status = "conciliada";
      else if (charge && !inv) status = "sin_factura";
      else if (inv && !charge) status = "sin_cargo";
      else if (inv && charge) status = "sugerida";
      else status = "sin_datos";

      return {
        key: pack.key,
        products: pack.products,
        total: pack.total,
        status,
        invoice: inv
          ? { id: inv.id, name: (inv.counterparty ?? inv.description).split(" - ").slice(1).join(" - ") || inv.description, amount: Math.abs(Number(inv.amount)), date: inv.date }
          : null,
        charge: charge
          ? { description: charge.unit.rows[0].description, amount: charge.unit.amount, count: charge.unit.count, date: charge.unit.date }
          : null,
      };
    };
    return {
      purchaseId: link.purchase.purchaseId,
      date: link.purchase.date,
      total: link.purchase.packs.reduce((acc, p) => acc + p.total, 0),
      packs: link.purchase.packs.map(packView),
    };
  }).reverse();
}
