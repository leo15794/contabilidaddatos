import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { matchItems, matches, transactions } from "@/db/schema";

/**
 * Cuenta corriente de clientes (facturas emitidas) y proveedores (facturas
 * recibidas): agrupa por CUIT de la contraparte — no por nombre, porque la
 * misma empresa puede aparecer escrita distinto entre comprobantes ("BOLDT
 * S.A." vs "BOLDT SA") y el CUIT no cambia nunca.
 *
 * El saldo usa lo que la app YA sabe (no inventa pagos nuevos): de cada
 * factura, si está conciliada (match con status auto/confirmed/manual)
 * cuenta como cobrada/pagada; si no, suma al saldo pendiente. Es el mismo
 * criterio que separa "conciliados" de "sin conciliar" en todo el resto de
 * la app (ver `bucketFor` en queries.ts).
 */

export type Source = "afip_issued" | "afip_received";

export type CuentaCorrienteRow = {
  /** null = no se pudo leer un CUIT de 11 dígitos en `counterparty` para ninguno de sus comprobantes. */
  cuit: string | null;
  denominacion: string;
  facturado: number;
  conciliado: number;
  saldo: number;
  cantidadFacturas: number;
  cantidadPendientes: number;
};

export type Txn = typeof transactions.$inferSelect;

export type FacturaConEstado = {
  txn: Txn;
  estado: "conciliada" | "pendiente" | "sin_conciliar";
  pago: Txn | null;
};

/** "33710121619 - ENFOQUE PROFESIONAL S.R.L." -> { cuit, denominacion } (ver cómo se arma en afip-csv.ts). */
export function parseCounterparty(counterparty: string | null): { cuit: string | null; denominacion: string } {
  if (!counterparty) return { cuit: null, denominacion: "Sin identificar" };
  const m = counterparty.match(/^(\d{11})\s*-\s*(.+)$/);
  if (!m) return { cuit: null, denominacion: counterparty.trim() || "Sin identificar" };
  return { cuit: m[1], denominacion: m[2].trim() || "Sin identificar" };
}

async function getMatchStatusByTxnId(): Promise<Map<number, string>> {
  const rows = await db
    .select({ transactionId: matchItems.transactionId, status: matches.status })
    .from(matchItems)
    .innerJoin(matches, eq(matches.id, matchItems.matchId));

  // Si una transacción quedó en más de un match, el "más resuelto" gana
  // (mismo criterio que bucketFor en queries.ts).
  const priority: Record<string, number> = { confirmed: 3, manual: 3, auto: 3, pending: 2, rejected: 1 };
  const best = new Map<number, string>();
  for (const r of rows) {
    const prev = best.get(r.transactionId);
    if (!prev || (priority[r.status] ?? 0) > (priority[prev] ?? 0)) best.set(r.transactionId, r.status);
  }
  return best;
}

function isConciliada(status: string | undefined): boolean {
  return status === "auto" || status === "confirmed" || status === "manual";
}

async function buildCuentaCorriente(source: Source): Promise<CuentaCorrienteRow[]> {
  const txns = await db.select().from(transactions).where(eq(transactions.source, source));
  const statusByTxnId = await getMatchStatusByTxnId();

  type Acc = CuentaCorrienteRow & { denomCounts: Map<string, number> };
  const byKey = new Map<string, Acc>();

  for (const t of txns) {
    const { cuit, denominacion } = parseCounterparty(t.counterparty);
    const key = cuit ?? `sin-identificar:${denominacion}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        cuit,
        denominacion,
        facturado: 0,
        conciliado: 0,
        saldo: 0,
        cantidadFacturas: 0,
        cantidadPendientes: 0,
        denomCounts: new Map(),
      });
    }
    const row = byKey.get(key)!;
    const amount = Math.abs(Number(t.amount));
    row.facturado += amount;
    row.cantidadFacturas++;
    row.denomCounts.set(denominacion, (row.denomCounts.get(denominacion) ?? 0) + 1);
    if (isConciliada(statusByTxnId.get(t.id))) {
      row.conciliado += amount;
    } else {
      row.cantidadPendientes++;
    }
  }

  return [...byKey.values()]
    .map((r) => {
      // La denominación más frecuente para ese CUIT, por si vino escrita
      // distinto entre comprobantes.
      let bestDenom = r.denominacion;
      let bestCount = 0;
      for (const [d, c] of r.denomCounts) {
        if (c > bestCount) {
          bestDenom = d;
          bestCount = c;
        }
      }
      return {
        cuit: r.cuit,
        denominacion: bestDenom,
        facturado: r.facturado,
        conciliado: r.conciliado,
        saldo: r.facturado - r.conciliado,
        cantidadFacturas: r.cantidadFacturas,
        cantidadPendientes: r.cantidadPendientes,
      };
    })
    .sort((a, b) => b.saldo - a.saldo);
}

/** Clientes: contrapartes de facturas EMITIDAS (lo que te deben). */
export function getClientesCuentaCorriente() {
  return buildCuentaCorriente("afip_issued");
}

/** Proveedores: contrapartes de facturas RECIBIDAS (lo que debés). */
export function getProveedoresCuentaCorriente() {
  return buildCuentaCorriente("afip_received");
}

/** Detalle factura por factura de una contraparte puntual, con su pago cruzado si lo tiene. */
export async function getCuentaCorrienteDetalle(source: Source, cuit: string): Promise<FacturaConEstado[]> {
  const txns = await db.select().from(transactions).where(eq(transactions.source, source));
  const propias = txns.filter((t) => parseCounterparty(t.counterparty).cuit === cuit);
  if (propias.length === 0) return [];

  const propiaIds = propias.map((t) => t.id);
  const matchRows = await db
    .select({ matchId: matchItems.matchId, transactionId: matchItems.transactionId, status: matches.status })
    .from(matchItems)
    .innerJoin(matches, eq(matches.id, matchItems.matchId))
    .where(sql`${matchItems.transactionId} in ${propiaIds.length ? sql`(${sql.join(propiaIds.map((id) => sql`${id}`), sql`, `)})` : sql`(null)`}`);

  const matchIdByTxn = new Map<number, { matchId: number; status: string }>();
  for (const r of matchRows) {
    const prev = matchIdByTxn.get(r.transactionId);
    const priority: Record<string, number> = { confirmed: 3, manual: 3, auto: 3, pending: 2, rejected: 1 };
    if (!prev || (priority[r.status] ?? 0) > (priority[prev.status] ?? 0)) {
      matchIdByTxn.set(r.transactionId, { matchId: r.matchId, status: r.status });
    }
  }

  const relevantMatchIds = [...new Set([...matchIdByTxn.values()].map((v) => v.matchId))];
  const otherItems = relevantMatchIds.length
    ? await db
        .select({ txn: transactions, matchId: matchItems.matchId })
        .from(matchItems)
        .innerJoin(transactions, eq(transactions.id, matchItems.transactionId))
        .where(and(sql`${matchItems.matchId} in ${sql`(${sql.join(relevantMatchIds.map((id) => sql`${id}`), sql`, `)})`}`))
    : [];

  const paymentByMatchId = new Map<number, Txn>();
  for (const { txn, matchId } of otherItems) {
    if (!propiaIds.includes(txn.id)) paymentByMatchId.set(matchId, txn);
  }

  return propias
    .map((txn) => {
      const info = matchIdByTxn.get(txn.id);
      const estado: FacturaConEstado["estado"] = !info
        ? "sin_conciliar"
        : isConciliada(info.status)
          ? "conciliada"
          : "pendiente";
      const pago = info ? paymentByMatchId.get(info.matchId) ?? null : null;
      return { txn, estado, pago };
    })
    .sort((a, b) => b.txn.date.getTime() - a.txn.date.getTime());
}
