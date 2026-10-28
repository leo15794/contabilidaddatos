import * as XLSX from "xlsx";
import { getSession } from "@/lib/auth/session";
import { getUnmatchedAll, UNMATCHED_SOURCES, type UnmatchedSource } from "@/lib/queries";
import { groupOf, groupTransactions } from "@/lib/unmatched-groups";

/**
 * Excel con los movimientos sin ningún match de una fuente: una hoja con el
 * resumen por proveedor/comercio (para ver qué comprobantes faltan pedir) y
 * otra con el detalle movimiento por movimiento. Con `?grupo=<clave>` exporta
 * solo ese proveedor/comercio.
 */
const SOURCE_LABELS: Record<UnmatchedSource, string> = {
  bank: "Banco",
  card: "Tarjeta",
  afip_issued: "AFIP emitidas",
  afip_received: "AFIP recibidas",
  ticket: "Tickets",
  retention: "Retenciones",
  cash: "Efectivo",
};

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export async function GET(request: Request, { params }: { params: Promise<{ fuente: string }> }) {
  // El proxy ya exige sesión; se vuelve a verificar acá por si cambia su matcher.
  if (!(await getSession())) return new Response("No autorizado", { status: 401 });

  const { fuente } = await params;
  if (!(UNMATCHED_SOURCES as readonly string[]).includes(fuente)) {
    return new Response("Fuente inválida", { status: 404 });
  }
  const source = fuente as UnmatchedSource;

  const grupo = new URL(request.url).searchParams.get("grupo");
  const all = await getUnmatchedAll(source);
  const rows = grupo ? all.filter((t) => groupOf(t).key === grupo) : all;

  const resumen = groupTransactions(rows).map((g) => ({
    [source === "afip_received" ? "Proveedor" : source === "afip_issued" ? "Cliente" : "Comercio / destinatario"]: g.label,
    CUIT: g.cuit ?? "",
    Movimientos: g.count,
    [source === "afip_received" || source === "afip_issued" ? "Total neto de notas de crédito" : "Total (valor absoluto)"]:
      Math.round(g.total * 100) / 100,
    Desde: isoDay(g.first),
    Hasta: isoDay(g.last),
  }));

  const detalle = rows.map((t) => {
    const g = groupOf(t);
    return {
      Fecha: isoDay(t.date),
      Fuente: SOURCE_LABELS[source],
      Descripción: t.description,
      Contraparte: g.label,
      CUIT: g.cuit ?? "",
      Importe: Number(t.amount),
      Cuenta: t.accountRef ?? "",
    };
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(resumen), "Resumen");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detalle), "Detalle");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  const filename = `sin-conciliar-${source}${grupo ? "-grupo" : ""}-${isoDay(new Date())}.xlsx`;
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
