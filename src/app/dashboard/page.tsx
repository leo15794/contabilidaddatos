import { NavBar } from "@/components/nav-bar";
import { getDashboardSummary, getCategorizedBreakdown } from "@/lib/queries";
import { ReconcileButton } from "./reconcile-button";
import { Card, CardHeader, SourceBadge, Amount, EmptyState, StatCard } from "@/components/ui";
import {
  IconArrowUpRight,
  IconArrowDownRight,
  IconCheckCircle,
  IconClock,
  IconAlertTriangle,
  IconFileText,
} from "@/components/icons";

export const dynamic = "force-dynamic";

const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });
// Para las stat cards usamos montos sin centavos — son números grandes y los
// centavos no aportan nada de un vistazo, solo hacen que el valor sea más
// largo y más fácil de que se corte en una card chica. El monto exacto (con
// centavos) queda igual disponible al pasar el mouse por encima (title).
const fmtCompact = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { from: fromStr, to: toStr } = await searchParams;

  // Fechas en los inputs vienen como "yyyy-mm-dd" (hora local). "to" se lleva
  // hasta el final del día para que incluya todo ese día.
  let from = fromStr ? new Date(`${fromStr}T00:00:00`) : undefined;
  let to = toStr ? new Date(`${toStr}T23:59:59.999`) : undefined;
  // Si por error "desde" quedó después de "hasta" (ej: año mal tipeado), se
  // reordenan en vez de devolver siempre cero resultados en silencio.
  const datesSwapped = Boolean(from && to && from > to);
  if (datesSwapped) {
    const fromDay = fromStr!;
    const toDay = toStr!;
    from = new Date(`${toDay}T00:00:00`);
    to = new Date(`${fromDay}T23:59:59.999`);
  }
  const hasFilter = Boolean(from || to);

  const [summary, categorizedBreakdown] = await Promise.all([
    getDashboardSummary({ from, to }),
    getCategorizedBreakdown({ from, to }),
  ]);

  return (
    <div className="flex min-h-screen flex-col">
      <NavBar />

      <div className="bg-gradient-to-br from-indigo-50 via-violet-50/70 to-slate-50 px-4 pb-8 pt-10">
        <div className="mx-auto w-full max-w-5xl">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-[32px] font-extrabold tracking-tight text-slate-900">Dashboard</h1>
              <p className="mt-1 text-sm text-slate-500">Estado general de la conciliación</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <form className="flex items-end gap-2" action="/dashboard" method="GET">
                <label className="flex flex-col text-xs text-slate-500">
                  Desde
                  <input
                    type="date"
                    name="from"
                    defaultValue={fromStr ?? ""}
                    className="mt-1 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  />
                </label>
                <label className="flex flex-col text-xs text-slate-500">
                  Hasta
                  <input
                    type="date"
                    name="to"
                    defaultValue={toStr ?? ""}
                    className="mt-1 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  />
                </label>
                <button
                  type="submit"
                  className="rounded-xl bg-indigo-600 px-3.5 py-1.5 text-sm font-semibold text-white shadow-[0_8px_20px_-8px_rgba(79,70,229,.55)] hover:bg-indigo-700"
                >
                  Filtrar
                </button>
                {hasFilter && (
                  <a
                    href="/dashboard"
                    className="rounded-xl px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-white/70"
                  >
                    Limpiar
                  </a>
                )}
              </form>
              <ReconcileButton />
            </div>
          </div>

          {hasFilter && (
            <p className="mt-4 text-xs text-slate-500">
              {datesSwapped && (
                <span className="mr-1 font-medium text-amber-600">
                  &quot;Desde&quot; estaba después de &quot;Hasta&quot;, así que se invirtieron solos —
                </span>
              )}
              Mostrando movimientos {from ? `desde ${from.toLocaleDateString("es-AR")}` : ""}
              {from && to ? " " : ""}
              {to ? `hasta ${to.toLocaleDateString("es-AR")}` : ""}.
            </p>
          )}
        </div>
      </div>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <div className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <FlowCard ingresos={summary.ingresos} egresos={summary.egresos} />
          <StatCard
            label="Conciliado"
            value={`${summary.conciliadoPct}%`}
            tone="highlight"
            icon={<IconCheckCircle width={17} height={17} />}
          />
          <StatCard
            label="Pendientes de revisar"
            value={String(summary.pendingReviewCount)}
            tone={summary.pendingReviewCount > 0 ? "warning" : "neutral"}
            icon={<IconClock width={17} height={17} />}
          />
          <StatCard
            label="Gastos (tickets) sin factura"
            value={String(summary.ticketsSinFactura)}
            tone={summary.ticketsSinFactura > 0 ? "warning" : "neutral"}
            icon={<IconAlertTriangle width={17} height={17} />}
          />
        </div>

        <Card className="mb-6">
          <CardHeader title="Por fuente" />
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-5 py-2.5 font-medium">Fuente</th>
                <th className="px-5 py-2.5 font-medium">Movimientos</th>
                <th className="px-5 py-2.5 font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(summary.bySource).map(([source, data]) => (
                <tr key={source} className="border-t border-slate-100 hover:bg-slate-50/80">
                  <td className="px-5 py-3">
                    <SourceBadge source={source} />
                  </td>
                  <td className="px-5 py-3 text-slate-600">{data.count}</td>
                  <td className="px-5 py-3">
                    <Amount value={data.total} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card>
          <CardHeader
            title="Movimientos categorizados"
            subtitle="Impuestos, comisiones, retiros y demás movimientos internos del banco que ya no cuentan como 'sin conciliar'."
          />
          {categorizedBreakdown.length === 0 ? (
            <EmptyState
              icon={<IconFileText width={20} height={20} />}
              title="No hay movimientos categorizados todavía"
              description="Cuando se categorice un movimiento de banco (impuestos, comisiones, honorarios, etc.) va a aparecer acá agrupado por tipo."
            />
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Categoría</th>
                  <th className="px-5 py-2.5 font-medium">Movimientos</th>
                  <th className="px-5 py-2.5 font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {categorizedBreakdown.map((row) => (
                  <tr key={row.category} className="border-t border-slate-100 hover:bg-slate-50/80">
                    <td className="px-5 py-3 text-slate-700">{row.category}</td>
                    <td className="px-5 py-3 text-slate-600">{row.count}</td>
                    {/* Monto en valor absoluto (ver getCategorizedBreakdown) — no es un
                        ingreso ni un egreso real, es la magnitud de lo categorizado, así
                        que va en gris neutro y no con el verde/rojo de <Amount> (que
                        confundiría "categorizado" con "plata que entró"). */}
                    <td className="whitespace-nowrap px-5 py-3 font-medium tabular-nums text-slate-700">
                      {fmt.format(row.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </main>
    </div>
  );
}

// Ingresos y egresos combinados en una sola card de dos líneas en vez de dos
// tiles separados — además de liberar un lugar en la grilla, evita que un
// monto grande (varios dígitos) tenga que competir por el ancho completo de
// una card angosta y se corte.
function FlowCard({ ingresos, egresos }: { ingresos: number; egresos: number }) {
  return (
    <div className="rounded-2xl border border-slate-100 bg-white px-4 py-3.5 shadow-[0_1px_2px_rgba(15,23,42,.04),0_10px_28px_-16px_rgba(15,23,42,.14)] transition-shadow hover:shadow-[0_1px_2px_rgba(15,23,42,.04),0_14px_32px_-14px_rgba(15,23,42,.18)]">
      <p className="text-xs text-slate-500">Flujo del período</p>
      <div className="mt-1.5 space-y-1">
        <p
          className="flex items-center gap-1 truncate text-sm font-bold tabular-nums text-emerald-600"
          title={fmt.format(ingresos)}
        >
          <IconArrowUpRight width={13} height={13} className="shrink-0" />
          {fmtCompact.format(ingresos)}
        </p>
        <p
          className="flex items-center gap-1 truncate text-sm font-bold tabular-nums text-rose-600"
          title={fmt.format(egresos)}
        >
          <IconArrowDownRight width={13} height={13} className="shrink-0" />
          {fmtCompact.format(egresos)}
        </p>
      </div>
    </div>
  );
}
