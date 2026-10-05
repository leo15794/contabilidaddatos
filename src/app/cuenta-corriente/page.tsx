import Link from "next/link";
import { NavBar } from "@/components/nav-bar";
import { getClientesCuentaCorriente, getProveedoresCuentaCorriente, type CuentaCorrienteRow } from "@/lib/cuenta-corriente";
import { Card, CardHeader, EmptyState } from "@/components/ui";
import { IconScale } from "@/components/icons";

export const dynamic = "force-dynamic";

const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });

export default async function CuentaCorrientePage() {
  const [clientes, proveedores] = await Promise.all([
    getClientesCuentaCorriente(),
    getProveedoresCuentaCorriente(),
  ]);

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
          <CuentaTable rows={clientes} tipo="clientes" />
        </Card>

        <Card>
          <CardHeader
            title="Proveedores"
            subtitle="Contrapartes de las facturas recibidas — lo que debés."
          />
          <CuentaTable rows={proveedores} tipo="proveedores" />
        </Card>
      </main>
    </div>
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

function CuentaTable({ rows, tipo }: { rows: CuentaCorrienteRow[]; tipo: "clientes" | "proveedores" }) {
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
          <th className="px-6 py-2.5 font-medium"></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const href = r.cuit ? `/cuenta-corriente/${tipo}/${r.cuit}` : null;
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
