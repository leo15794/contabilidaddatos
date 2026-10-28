import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { matchItems, matches, transactions } from "@/db/schema";
import { isCreditNote, netAmount } from "@/lib/amounts";
import { PENDING_PAYMENT_CATEGORY } from "@/lib/categories";
import { parseCounterparty, type Periodo, type Source } from "@/lib/cuenta-corriente";

/**
 * Cuenta corriente de UN cliente o proveedor como libro: cada factura al Debe,
 * cada pago, retención o nota de crédito al Haber, y el saldo acumulado renglón
 * por renglón (lo que se debe / lo que te deben).
 *
 * Un pago entra una sola vez aunque cancele varias facturas, con la nota de qué
 * facturas paga. Si el mismo pago cubre facturas de OTROS proveedores (un carrito
 * de MercadoPago), al Haber va solo la parte de este proveedor.
 */

type Txn = typeof transactions.$inferSelect;

export type EstadoFactura = "pagada" | "pendiente_pago" | "revisar" | "sin_conciliar" | "categorizada";

export type MovimientoLibro = {
  id: string;
  fecha: Date;
  tipo: "factura" | "nota_credito" | "pago" | "retencion";
  concepto: string;
  detalle?: string;
  debe: number;
  haber: number;
  saldo: number;
  estado?: EstadoFactura;
  categoria?: string | null;
  fuente?: string;
};

export type FacturaAbierta = {
  txn: Txn;
  numero: string;
  importe: number;
  dias: number;
  estado: EstadoFactura;
  categoria: string | null;
};

export type ResumenMes = { mes: string; debe: number; haber: number; saldo: number };

export type LibroCuentaCorriente = {
  cuit: string;
  denominacion: string;
  saldoAnterior: number;
  movimientos: MovimientoLibro[];
  abiertas: FacturaAbierta[];
  meses: ResumenMes[];
  totales: { facturado: number; pagado: number; retenciones: number; saldo: number };
  ultimoComprobante: Date | null;
};

/** "1 - Factura A · 9.0-1144885.0 · NOSIS ..." -> { tipo: "Factura A", numero: "0009-01144885" } */
export function comprobanteLegible(description: string): { tipo: string; numero: string } {
  const [tipoRaw = "", numRaw = ""] = description.split(" · ");
  const tipo = tipoRaw.replace(/^\d+\s*-\s*/, "").trim() || "Comprobante";
  const m = numRaw.replace(/\.0+(?=-|$)/g, "").match(/^(\d+)-(\d+)$/);
  const numero = m ? `${m[1].padStart(4, "0")}-${m[2].padStart(8, "0")}` : numRaw.trim();
  return { tipo, numero };
}

function conceptoPago(t: Txn): { concepto: string; tipo: MovimientoLibro["tipo"] } {
  if (t.source === "retention") return { concepto: t.description.replace(/\s*\(.*?\)\s*/, " "), tipo: "retencion" };
  if (t.source === "card") return { concepto: `Tarjeta · ${t.description}`, tipo: "pago" };
  if (t.source === "ticket") return { concepto: `Ticket · ${t.description}`, tipo: "pago" };
  return { concepto: `Banco · ${t.description}`, tipo: "pago" };
}

const CONCILIADO = new Set(["auto", "confirmed", "manual"]);
const DAY_MS = 24 * 60 * 60 * 1000;

export async function getLibroCuentaCorriente(
  source: Source,
  cuit: string,
  periodo: Periodo = {},
): Promise<LibroCuentaCorriente | null> {
  const all = await db.select().from(transactions).where(eq(transactions.source, source));
  const docs = all.filter((t) => parseCounterparty(t.counterparty).cuit === cuit);
  if (docs.length === 0) return null;
  const docIds = new Set(docs.map((d) => d.id));

  // Matches (no rechazados) donde participa alguna factura de este CUIT, con todos sus movimientos.
  const docMatchRows = await db
    .select({ matchId: matchItems.matchId, transactionId: matchItems.transactionId, status: matches.status })
    .from(matchItems)
    .innerJoin(matches, eq(matches.id, matchItems.matchId))
    .where(and(inArray(matchItems.transactionId, [...docIds]), ne(matches.status, "rejected")));
  const statusByDoc = new Map<number, string>();
  for (const r of docMatchRows) {
    const prev = statusByDoc.get(r.transactionId);
    if (!prev || CONCILIADO.has(r.status)) statusByDoc.set(r.transactionId, r.status);
  }
  const conciliatedMatchIds = [...new Set(docMatchRows.filter((r) => CONCILIADO.has(r.status)).map((r) => r.matchId))];
  const items = conciliatedMatchIds.length
    ? await db
        .select({ matchId: matchItems.matchId, txn: transactions })
        .from(matchItems)
        .innerJoin(transactions, eq(transactions.id, matchItems.transactionId))
        .where(inArray(matchItems.matchId, conciliatedMatchIds))
    : [];

  const estadoDe = (d: Txn): EstadoFactura => {
    const st = statusByDoc.get(d.id);
    if (st && CONCILIADO.has(st)) return "pagada";
    if (st === "pending") return "revisar";
    if (d.category === PENDING_PAYMENT_CATEGORY) return "pendiente_pago";
    if (d.category) return "categorizada";
    return "sin_conciliar";
  };

  type Mov = Omit<MovimientoLibro, "saldo">;
  const movs: Mov[] = [];
  for (const d of docs) {
    const importe = netAmount(d.source, d.amount);
    const { tipo, numero } = comprobanteLegible(d.description);
    const nc = isCreditNote(d.description) || importe < 0;
    movs.push({
      id: `d${d.id}`,
      fecha: d.date,
      tipo: nc ? "nota_credito" : "factura",
      concepto: `${tipo} ${numero}`.trim(),
      debe: nc ? 0 : importe,
      haber: nc ? -importe : 0,
      estado: nc ? undefined : estadoDe(d),
      categoria: d.category,
    });
  }

  // Pagos: un renglón por movimiento real. Si el match incluye facturas de otro CUIT, solo la parte de este.
  const byMatch = new Map<number, Txn[]>();
  for (const { matchId, txn } of items) {
    const list = byMatch.get(matchId);
    if (list) list.push(txn);
    else byMatch.set(matchId, [txn]);
  }
  const seenPayments = new Set<number>();
  for (const txns of byMatch.values()) {
    const propios = txns.filter((t) => docIds.has(t.id));
    const otrosDocs = txns.filter((t) => !docIds.has(t.id) && (t.source === "afip_issued" || t.source === "afip_received"));
    const pagos = txns.filter((t) => !docIds.has(t.id) && t.source !== "afip_issued" && t.source !== "afip_received");
    if (propios.length === 0 || pagos.length === 0) continue;
    const numeros = propios.map((p) => comprobanteLegible(p.description).numero.split("-").pop()?.replace(/^0+/, ""));
    const detalle = `paga ${propios.length > 1 ? "FC " + numeros.join(", ") : "FC " + numeros[0]}`;

    if (otrosDocs.length > 0) {
      // Carrito u otro pago compartido: va un solo renglón con la parte de este proveedor.
      const parte = propios.reduce((acc, p) => acc + netAmount(p.source, p.amount), 0);
      const pago = pagos[0];
      const { concepto, tipo } = conceptoPago(pago);
      movs.push({
        id: `p${pago.id}-${propios[0].id}`,
        fecha: pago.date,
        tipo,
        concepto,
        detalle: `${detalle} · parte de un pago de ${Math.abs(Number(pago.amount)).toLocaleString("es-AR", { minimumFractionDigits: 2 })}`,
        debe: 0,
        haber: parte,
        fuente: pago.source,
      });
      continue;
    }
    for (const pago of pagos) {
      if (seenPayments.has(pago.id)) continue;
      seenPayments.add(pago.id);
      const { concepto, tipo } = conceptoPago(pago);
      movs.push({
        id: `p${pago.id}`,
        fecha: pago.date,
        tipo,
        concepto,
        detalle,
        debe: 0,
        haber: Math.abs(Number(pago.amount)) * (Number(pago.amount) < 0 && pago.source === "retention" ? -1 : 1),
        fuente: pago.source,
      });
    }
  }

  // Orden: por fecha; el mismo día, primero las facturas y después lo que las paga.
  const orden = { factura: 0, nota_credito: 1, pago: 2, retencion: 3 } as const;
  movs.sort((a, b) => a.fecha.getTime() - b.fecha.getTime() || orden[a.tipo] - orden[b.tipo]);

  const enPeriodo = (d: Date) => periodo.anio === undefined || d.getUTCFullYear() === periodo.anio;
  const antes = (d: Date) => periodo.anio !== undefined && d.getUTCFullYear() < periodo.anio;
  const saldoAnterior = movs.filter((m) => antes(m.fecha)).reduce((acc, m) => acc + m.debe - m.haber, 0);

  let saldo = saldoAnterior;
  const movimientos: MovimientoLibro[] = [];
  for (const m of movs.filter((x) => enPeriodo(x.fecha))) {
    saldo += m.debe - m.haber;
    movimientos.push({ ...m, saldo });
  }

  const mesesMap = new Map<string, ResumenMes>();
  for (const m of movimientos) {
    const key = m.fecha.toISOString().slice(0, 7);
    const r = mesesMap.get(key) ?? { mes: key, debe: 0, haber: 0, saldo: 0 };
    r.debe += m.debe;
    r.haber += m.haber;
    r.saldo = m.saldo;
    mesesMap.set(key, r);
  }

  const hoy = Date.now();
  const abiertas: FacturaAbierta[] = docs
    .filter((d) => enPeriodo(d.date))
    .map((d) => ({ d, importe: netAmount(d.source, d.amount), estado: estadoDe(d) }))
    .filter((x) => x.importe > 0 && x.estado !== "pagada")
    .map(({ d, importe, estado }) => ({
      txn: d,
      numero: (({ tipo, numero }) => `${tipo} ${numero}`)(comprobanteLegible(d.description)),
      importe,
      dias: Math.floor((hoy - d.date.getTime()) / DAY_MS),
      estado,
      categoria: d.category,
    }))
    .sort((a, b) => a.txn.date.getTime() - b.txn.date.getTime());

  const denomCounts = new Map<string, number>();
  for (const d of docs) {
    const n = parseCounterparty(d.counterparty).denominacion;
    denomCounts.set(n, (denomCounts.get(n) ?? 0) + 1);
  }
  const denominacion = [...denomCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];

  const facturado = movimientos.reduce((acc, m) => acc + (m.tipo === "factura" ? m.debe : m.tipo === "nota_credito" ? -m.haber : 0), 0);
  const retenciones = movimientos.filter((m) => m.tipo === "retencion").reduce((acc, m) => acc + m.haber, 0);
  const pagado = movimientos.filter((m) => m.tipo === "pago").reduce((acc, m) => acc + m.haber, 0);

  return {
    cuit,
    denominacion,
    saldoAnterior,
    movimientos,
    abiertas,
    meses: [...mesesMap.values()],
    totales: { facturado, pagado, retenciones, saldo },
    ultimoComprobante: docs.reduce<Date | null>((acc, d) => (!acc || d.date > acc ? d.date : acc), null),
  };
}
