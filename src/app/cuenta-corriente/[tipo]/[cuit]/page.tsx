import Link from "next/link";
import { notFound } from "next/navigation";
import { NavBar } from "@/components/nav-bar";
import {
  getClientesCuentaCorriente,
  getProveedoresCuentaCorriente,
  getCuentaCorrienteDetalle,
  type Source,
} from "@/lib/cuenta-corriente";
import { Card, CardHeader, SourceBadge } from "@/components/ui";
import { IconArrowLeft } from "@/components/icons";

export const dynamic = "force-dynamic";

const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });
const fmtDate = new Intl.DateTimeFormat("es-AR", { dateStyle: "short" });

const TIPO_TO_SOURCE: Record<string, Source> = {
  clientes: "afip_issued",
  proveedores: "afip_received",
};

const ESTADO_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  conciliada: { bg: "bg-emerald-100", text: "text-emerald-800", label: "Conciliada" },
  pendiente: { bg: "bg-amber-100", text: "text-amber-800", label: "Pendiente de revisar" },
  sin_conciliar: { bg: "bg-slate-100", text: "text-slate-600", label: "Sin conciliar" },
};

export default async function CuentaCorrienteDetallePage({
  params,
}: {
  params: Promise<{ tipo: string; cuit: string }>;
}) {
  const { tipo, cuit } = await params;
  const source = TIPO_TO_SOURCE[tipo];
  if (!source) notFound();

  const [resumen, facturas] = await Promise.all([
    tipo === "clientes" ? getClientesCuentaCorriente() : getProveedoresCuentaCorriente(),
    getCuentaCorrienteDetalle(source, cuit),
  ]);
  const fila = resumen.find((r) => r.cuit === cuit);
  if (!fila || facturas.length === 0) notFound();

  return (
    <div className="flex min-h-screen flex-col">
      <NavBar />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <Link
          href="/cuenta-corriente"
          className="mb-4 inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-800"
        >
          <IconArrowLeft width={13} height={13} />
          Volver a Cuenta corriente
        </Link>

        <div className="mb-6">
          <h1 className="text-xl font-semibold text-slate-900">{fila.denominacion}</h1>
          <p className="mt-1 text-sm text-slate-500">
            CUIT {cuit} · {tipo === "clientes" ? "Cliente" : "Proveedor"}
          </p>
        </div>

        <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <MiniStat label="Facturado" value={fmt.format(fila.facturado)} tone="neutral" />
          <MiniStat label="Conciliado" value={fmt.format(fila.conciliado)} tone="positive" />
          <MiniStat
            label="Saldo"
            value={fmt.format(fila.saldo)}
            tone={fila.saldo > 0.5 ? "warning" : "positive"}
          />
          <MiniStat label="Pendientes" value={`${fila.cantidadPendientes} / ${fila.cantidadFacturas}`} tone="neutral" />
        </div>

        <Card>
          <CardHeader title="Comprobantes" subtitle="Cada factura con su estado y, si está conciliada, el pago cruzado." />
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-6 py-2.5 font-medium">Fecha</th>
                <th className="px-6 py-2.5 font-medium">Comprobante</th>
                <th className="px-6 py-2.5 font-medium">Importe</th>
                <th className="px-6 py-2.5 font-medium">Estado</th>
                <th className="px-6 py-2.5 font-medium">Pago cruzado</th>
              </tr>
            </thead>
            <tbody>
              {facturas.map(({ txn, estado, pago }) => {
                const style = ESTADO_STYLES[estado];
                return (
                  <tr key={txn.id} className="border-t border-slate-100">
                    <td className="whitespace-nowrap px-6 py-3 text-slate-500">{fmtDate.format(txn.date)}</td>
                    <td className="px-6 py-3 text-slate-700">{txn.description}</td>
                    <td className="whitespace-nowrap px-6 py-3 tabular-nums text-slate-700">
                      {fmt.format(Math.abs(Number(txn.amount)))}
                    </td>
                    <td className="whitespace-nowrap px-6 py-3">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${style.bg} ${style.text}`}>
                        {style.label}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-slate-500">
                      {pago ? (
                        <span className="flex items-center gap-1.5 text-xs">
                          <SourceBadge source={pago.source} />
                          {fmtDate.format(pago.date)} · {fmt.format(Math.abs(Number(pago.amount)))}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      </main>
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone: "neutral" | "positive" | "warning" }) {
  const toneClass =
    tone === "positive" ? "text-emerald-600" : tone === "warning" ? "text-rose-600" : "text-slate-900";
  return (
    <div className="rounded-2xl border border-slate-100 bg-white px-4 py-3.5 shadow-[0_1px_2px_rgba(15,23,42,.04)]">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-1 text-lg font-bold tabular-nums ${toneClass}`}>{value}</p>
    </div>
  );
}
