import Link from "next/link";
import { NavBar } from "@/components/nav-bar";
import {
  getAniosConComprobantes,
  getClientesCuentaCorriente,
  getProveedoresCuentaCorriente,
  type CuentaCorrienteRow,
} from "@/lib/cuenta-corriente";
import { Card, CardHeader, EmptyState } from "@/components/ui";
import { IconScale } from "@/components/icons";

export const dynamic = "force-dynamic";

const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });
const fmtDate = new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeZone: "UTC" });

export default async function CuentaCorrientePage({ searchParams }: { searchParams: Promise<{ anio?: string }> }) {
  const { anio: anioParam } = await searchParams;
  const anios = await getAniosConComprobantes();
  // Solo se acepta un año que tenga comprobantes; cualquier otro valor muestra todo.
  const anio = anioParam && anios.includes(Number(anioParam)) ? Number(anioParam) : undefined;
  const periodo = { anio };

  const [clientes, proveedores] = await Promise.all([
    getClientesCuentaCorriente(periodo),
    getProveedoresCuentaCorriente(periodo),
  ]);
  const exportHref = `/api/cuenta-corriente/export${anio ? `?anio=${anio}` : ""}`;

  const totalPorCobrar = clientes.reduce((acc, c) => acc + c.saldo, 0);
  const totalPorPagar = proveedores.reduce((acc, p) => acc + p.saldo, 0);

  return (
    <div className="flex min-h-screen flex-col">
      <NavBar />

      <div className="bg-gradient-to-br from-indigo-50 via-violet-50/70 to-slate-50 px-4 pb-8 pt-10">
        <div className="mx-auto w-full max-w-5xl">
          <h1 className="text-[32px] font-extrabold tracking-tight text-slate-900">Cuenta corriente</h1>
          <p className="mt-1 text-sm text-slate-500">
            Saldo por cliente y proveedor, agrupado por CUIT — lo facturado menos lo que ya está conciliado.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <span className="mr-1 text-xs font-medium text-slate-500">Período:</span>
            <PeriodoChip href="/cuenta-corriente" label="Todo" active={anio === undefined} />
            {anios.map((a) => (
              <PeriodoChip key={a} href={`/cuenta-corriente?anio=${a}`} label={String(a)} active={anio === a} />
            ))}
            <a
              href={exportHref}
              className="ml-auto rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700"
            >
              Exportar a Excel
            </a>
          </div>
        </div>
      </div>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <div className="mb-7 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TotalCard
            label="Total por cobrar (clientes)"
            value={totalPorCobrar}
            tone="positive"
          />
          <TotalCard
            label="Total por pagar (proveedores)"
            value={totalPorPagar}
            tone="negative"
          />
        </div>

        <Card className="mb-7">
          <CardHeader
            title="Clientes"
            subtitle="Contrapartes de las facturas emitidas — lo que te deben."
          />
          <CuentaTable rows={clientes} tipo="clientes" anio={anio} />
        </Card>

        <Card>
          <CardHeader
            title="Proveedores"
            subtitle="Contrapartes de las facturas recibidas — lo que debés."
          />
          <CuentaTable rows={proveedores} tipo="proveedores" anio={anio} />
        </Card>
      </main>
    </div>
  );
}

function PeriodoChip({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`rounded-full px-3 py-1 text-xs font-semibold ${
        active ? "bg-indigo-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
      }`}
    >
      {label}
    </Link>
  );
}

function TotalCard({ label, value, tone }: { label: string; value: number; tone: "positive" | "negative" }) {
  const color = tone === "positive" ? "text-emerald-600" : "text-rose-600";
  return (
    <Card className="px-6 py-5">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-1.5 text-2xl font-extrabold tabular-nums ${color}`}>{fmt.format(value)}</p>
    </Card>
  );
}

function CuentaTable({ rows, tipo, anio }: { rows: CuentaCorrienteRow[]; tipo: "clientes" | "proveedores"; anio?: number }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<IconScale width={20} height={20} />}
        title="Todavía no hay comprobantes para mostrar acá"
        description="Importá facturas AFIP emitidas o recibidas para que aparezcan agrupadas por contraparte."
      />
    );
  }

  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs uppercase tracking-wide text-slate-400">
        <tr>
          <th className="px-6 py-2.5 font-medium">Contraparte</th>
          <th className="px-6 py-2.5 font-medium">Facturado</th>
          <th className="px-6 py-2.5 font-medium">Conciliado</th>
          <th className="px-6 py-2.5 font-medium">Saldo</th>
          <th className="px-6 py-2.5 font-medium">Pendientes</th>
          <th className="px-6 py-2.5 font-medium">Último</th>
          <th className="px-6 py-2.5 font-medium"></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const href = r.cuit ? `/cuenta-corriente/${tipo}/${r.cuit}${anio !== undefined ? `?anio=${anio}` : ""}` : null;
          return (
            <tr key={r.cuit ?? r.denominacion} className="border-t border-slate-100 hover:bg-slate-50/80">
              <td className="px-6 py-3 text-slate-700">
                {href ? (
                  <Link href={href} className="font-medium text-slate-700 hover:text-indigo-600">
                    {r.denominacion}
                  </Link>
                ) : (
                  <>
                    {r.denominacion}
                    <span className="ml-1.5 text-xs text-slate-400">(sin CUIT identificado)</span>
                  </>
                )}
              </td>
              <td className="whitespace-nowrap px-6 py-3 tabular-nums text-slate-700">{fmt.format(r.facturado)}</td>
              <td className="whitespace-nowrap px-6 py-3 tabular-nums text-slate-500">{fmt.format(r.conciliado)}</td>
              <td
                className={`whitespace-nowrap px-6 py-3 font-semibold tabular-nums ${
                  r.saldo > 0.5 ? "text-rose-600" : r.saldo < -0.5 ? "text-emerald-600" : "text-slate-400"
                }`}
              >
                {fmt.format(r.saldo)}
              </td>
              <td className="whitespace-nowrap px-6 py-3 text-slate-500">
                {r.cantidadPendientes} / {r.cantidadFacturas}
              </td>
              <td className="whitespace-nowrap px-6 py-3 text-slate-500">
                {r.ultimoComprobante ? fmtDate.format(r.ultimoComprobante) : "—"}
              </td>
              <td className="whitespace-nowrap px-6 py-3 text-right">
                {href && (
                  <Link href={href} className="text-xs font-semibold text-indigo-600">
                    Ver detalle →
                  </Link>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
