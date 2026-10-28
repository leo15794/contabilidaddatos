import * as XLSX from "xlsx";
import { getSession } from "@/lib/auth/session";
import {
  getAniosConComprobantes,
  getClientesCuentaCorriente,
  getComprobantesConEstado,
  getProveedoresCuentaCorriente,
  type ComprobanteConEstado,
  type CuentaCorrienteRow,
} from "@/lib/cuenta-corriente";

/**
 * Excel con el desglose de proveedores y clientes (lo que se arma a mano para
 * el contador): un resumen, una hoja por CUIT para cada lado y el detalle
 * comprobante por comprobante con su estado. Con `?anio=2025` solo ese año.
 *
 * Los importes son netos: las notas de crédito restan (ver `netAmount`).
 */
const MONEY = "#,##0.00;[Red]-#,##0.00";

const isoDay = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");
const round2 = (n: number) => Math.round(n * 100) / 100;

function withFormats(ws: XLSX.WorkSheet, moneyCols: number[], widths: number[]): XLSX.WorkSheet {
  const range = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
  for (let r = 1; r <= range.e.r; r++) {
    for (const c of moneyCols) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell && cell.t === "n") cell.z = MONEY;
    }
  }
  ws["!cols"] = widths.map((wch) => ({ wch }));
  ws["!autofilter"] = { ref: XLSX.utils.encode_range(range) };
  return ws;
}

function hojaPorCuit(rows: CuentaCorrienteRow[], pagadoLabel: string): XLSX.WorkSheet {
  const data = rows.map((r) => ({
    CUIT: r.cuit ?? "",
    "Razón social": r.denominacion,
    Comprobantes: r.cantidadFacturas,
    "Notas de crédito": r.cantidadNotasCredito,
    "Total neto": round2(r.facturado),
    [pagadoLabel]: round2(r.conciliado),
    Saldo: round2(r.saldo),
    "Sin conciliar": r.cantidadPendientes,
    "Primer comprobante": isoDay(r.primerComprobante),
    "Último comprobante": isoDay(r.ultimoComprobante),
  }));
  return withFormats(XLSX.utils.json_to_sheet(data), [4, 5, 6], [13, 42, 13, 15, 18, 18, 18, 13, 18, 18]);
}

function hojaDetalle(rows: ComprobanteConEstado[]): XLSX.WorkSheet {
  const data = rows.map((r) => ({
    Fecha: isoDay(r.txn.date),
    Comprobante: r.txn.description,
    CUIT: r.cuit ?? "",
    "Razón social": r.denominacion,
    "Importe neto": round2(r.importe),
    Estado: r.estado,
  }));
  return withFormats(XLSX.utils.json_to_sheet(data), [4], [11, 60, 13, 42, 16, 30]);
}

export async function GET(request: Request) {
  // El proxy ya exige sesión; se vuelve a verificar acá por si cambia su matcher.
  if (!(await getSession())) return new Response("No autorizado", { status: 401 });

  const anioParam = new URL(request.url).searchParams.get("anio");
  const anios = await getAniosConComprobantes();
  const anio = anioParam && anios.includes(Number(anioParam)) ? Number(anioParam) : undefined;
  const periodo = { anio };

  const [clientes, proveedores, detalleClientes, detalleProveedores] = await Promise.all([
    getClientesCuentaCorriente(periodo),
    getProveedoresCuentaCorriente(periodo),
    getComprobantesConEstado("afip_issued", periodo),
    getComprobantesConEstado("afip_received", periodo),
  ]);

  const sum = (rows: CuentaCorrienteRow[], k: "facturado" | "conciliado" | "saldo") =>
    round2(rows.reduce((acc, r) => acc + r[k], 0));
  const resumen = XLSX.utils.aoa_to_sheet([
    ["Proveedores y clientes", anio ? `Año ${anio}` : "Todo lo cargado"],
    ["Importes netos: facturas menos notas de crédito.", ""],
    [],
    ["", "Clientes", "Proveedores"],
    ["Cantidad (por CUIT)", clientes.length, proveedores.length],
    ["Total neto", sum(clientes, "facturado"), sum(proveedores, "facturado")],
    ["Conciliado (cobrado / pagado)", sum(clientes, "conciliado"), sum(proveedores, "conciliado")],
    ["Saldo (por cobrar / por pagar)", sum(clientes, "saldo"), sum(proveedores, "saldo")],
  ]);
  for (const ref of ["B6", "C6", "B7", "C7", "B8", "C8"]) if (resumen[ref]) resumen[ref].z = MONEY;
  resumen["!cols"] = [{ wch: 32 }, { wch: 20 }, { wch: 20 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, resumen, "Resumen");
  XLSX.utils.book_append_sheet(wb, hojaPorCuit(clientes, "Cobrado (conciliado)"), "Clientes");
  XLSX.utils.book_append_sheet(wb, hojaPorCuit(proveedores, "Pagado (conciliado)"), "Proveedores");
  XLSX.utils.book_append_sheet(wb, hojaDetalle(detalleClientes), "Detalle clientes");
  XLSX.utils.book_append_sheet(wb, hojaDetalle(detalleProveedores), "Detalle proveedores");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  const filename = `proveedores-y-clientes-${anio ?? "todo"}-${isoDay(new Date())}.xlsx`;
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
