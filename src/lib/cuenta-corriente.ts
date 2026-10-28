import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { matchItems, matches, transactions } from "@/db/schema";
import { isCreditNote, netAmount } from "@/lib/amounts";

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
  /** De esos comprobantes, cuántos son notas de crédito (restan). */
  cantidadNotasCredito: number;
  primerComprobante: Date | null;
  ultimoComprobante: Date | null;
};

/** Año calendario a mirar; sin año, todo lo cargado. */
export type Periodo = { anio?: number };

function inPeriod(date: Date, periodo: Periodo): boolean {
  return periodo.anio === undefined || date.getUTCFullYear() === periodo.anio;
}

export type Txn = typeof transactions.$inferSelect;

export type FacturaConEstado = {
  txn: Txn;
  estado: "conciliada" | "pendiente" | "sin_conciliar";
  pago: Txn | null;
};

/** "33710121619 - ENFOQUE PROFESIONAL S.R.L." -> { cuit, denominacion } (ver cómo se arma en afip-csv.ts). */
export function parseCounterparty(counterparty: string | null): { cuit: string | null; denominacion: string } {
  if (!counterparty) return { cuit: null, denominacion: "Sin identificar" };
  // Los comprobantes ya cargados traen el CUIT como número ("30717606392.0 - ..."), por eso el ".0" opcional.
  const m = counterparty.match(/^(\d{11})(?:\.0+)?\s*-\s*(.+)$/);
  if (!m) return { cuit: null, denominacion: counterparty.trim() || "Sin identificar" };
  return { cuit: m[1], denominacion: m[2].trim() || "Sin identificar" };
}

export async function getMatchStatusByTxnId(): Promise<Map<number, string>> {
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

export function isConciliada(status: string | undefined): boolean {
  return status === "auto" || status === "confirmed" || status === "manual";
}

async function buildCuentaCorriente(source: Source, periodo: Periodo = {}): Promise<CuentaCorrienteRow[]> {
  const txns = (await db.select().from(transactions).where(eq(transactions.source, source))).filter((t) =>
    inPeriod(t.date, periodo),
  );
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
        cantidadNotasCredito: 0,
        primerComprobante: null,
        ultimoComprobante: null,
        denomCounts: new Map(),
      });
    }
    const row = byKey.get(key)!;
    // Con signo: las notas de crédito RESTAN de lo facturado (y de lo conciliado, si
    // están conciliadas, ej. una factura anulada por su nota queda en cero).
    const amount = netAmount(t.source, t.amount);
    row.facturado += amount;
    row.cantidadFacturas++;
    if (isCreditNote(t.description)) row.cantidadNotasCredito++;
    if (!row.primerComprobante || t.date < row.primerComprobante) row.primerComprobante = t.date;
    if (!row.ultimoComprobante || t.date > row.ultimoComprobante) row.ultimoComprobante = t.date;
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
        cantidadNotasCredito: r.cantidadNotasCredito,
        primerComprobante: r.primerComprobante,
        ultimoComprobante: r.ultimoComprobante,
      };
    })
    .sort((a, b) => b.saldo - a.saldo);
}

/** Clientes: contrapartes de facturas EMITIDAS (lo que te deben). */
export function getClientesCuentaCorriente(periodo: Periodo = {}) {
  return buildCuentaCorriente("afip_issued", periodo);
}

/** Proveedores: contrapartes de facturas RECIBIDAS (lo que debés). */
export function getProveedoresCuentaCorriente(periodo: Periodo = {}) {
  return buildCuentaCorriente("afip_received", periodo);
}

/** Años con comprobantes de AFIP cargados, del más nuevo al más viejo (para el filtro de la pantalla). */
export async function getAniosConComprobantes(): Promise<number[]> {
  const rows = await db
    .select({ anio: sql<number>`distinct extract(year from ${transactions.date})::int` })
    .from(transactions)
    .where(inArray(transactions.source, ["afip_issued", "afip_received"]));
  return rows.map((r) => Number(r.anio)).sort((a, b) => b - a);
}

export type ComprobanteConEstado = {
  txn: Txn;
  cuit: string | null;
  denominacion: string;
  importe: number;
  /** "Conciliado", "Pendiente de revisar", la categoría que tenga ("Pendientes de pago", ...) o "Sin conciliar". */
  estado: string;
};

/** Todos los comprobantes de clientes o proveedores del período, con su estado (para el Excel). */
export async function getComprobantesConEstado(source: Source, periodo: Periodo = {}): Promise<ComprobanteConEstado[]> {
  const txns = (await db.select().from(transactions).where(eq(transactions.source, source))).filter((t) =>
    inPeriod(t.date, periodo),
  );
  const statusByTxnId = await getMatchStatusByTxnId();
  return txns
    .map((t) => {
      const { cuit, denominacion } = parseCounterparty(t.counterparty);
      const status = statusByTxnId.get(t.id);
      const estado = isConciliada(status)
        ? "Conciliado"
        : status === "pending"
          ? "Pendiente de revisar"
          : t.category || "Sin conciliar";
      return { txn: t, cuit, denominacion, importe: netAmount(t.source, t.amount), estado };
    })
    .sort((a, b) => a.txn.date.getTime() - b.txn.date.getTime() || a.txn.id - b.txn.id);
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
