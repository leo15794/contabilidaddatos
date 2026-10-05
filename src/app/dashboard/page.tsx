import { NavBar } from "@/components/nav-bar";
import { getDashboardSummary, getCategorizedBreakdown } from "@/lib/queries";
import { ReconcileButton } from "./reconcile-button";
import { Card, CardHeader, SourceBadge, Amount, EmptyState } from "@/components/ui";
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
        <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <Stat
            label="Ingresos"
            value={fmt.format(summary.ingresos)}
            tone="positive"
            icon={<IconArrowUpRight width={17} height={17} />}
          />
          <Stat
            label="Egresos"
            value={fmt.format(summary.egresos)}
            tone="negative"
            icon={<IconArrowDownRight width={17} height={17} />}
          />
          <Stat
            label="Conciliado"
            value={`${summary.conciliadoPct}%`}
            tone="dark"
            icon={<IconCheckCircle width={17} height={17} />}
          />
          <Stat
            label="Pendientes de revisar"
            value={String(summary.pendingReviewCount)}
            tone={summary.pendingReviewCount > 0 ? "warning" : "neutral"}
            icon={<IconClock width={17} height={17} />}
          />
          <Stat
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
                    <td className="px-5 py-3">
                      <Amount value={row.total} />
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

function Stat({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: string;
  tone: "positive" | "negative" | "brand" | "neutral" | "warning" | "violet" | "dark";
  icon: React.ReactNode;
}) {
  // "dark" es el tile destacado (hoy solo "Conciliado") — el número que más
  // importa de un vistazo se resalta con una card oscura en vez de competir
  // por atención con el resto, en vez de un tono más de la misma grilla clara.
  if (tone === "dark") {
    return (
      <div className="rounded-[20px] bg-gradient-to-br from-slate-900 to-slate-800 px-4 py-3.5 shadow-[0_14px_32px_-16px_rgba(15,23,42,.45)]">
        <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 text-violet-300">
          {icon}
        </div>
        <p className="text-xs text-slate-400">{label}</p>
        <p className="mt-0.5 text-lg font-bold tabular-nums text-white">{value}</p>
      </div>
    );
  }

  const styles = {
    positive: { text: "text-emerald-600", bg: "bg-emerald-50" },
    negative: { text: "text-rose-600", bg: "bg-rose-50" },
    brand: { text: "text-indigo-600", bg: "bg-indigo-50" },
    neutral: { text: "text-slate-700", bg: "bg-slate-100" },
    warning: { text: "text-amber-600", bg: "bg-amber-50" },
    violet: { text: "text-violet-600", bg: "bg-violet-50" },
  }[tone];

  return (
    <div className="rounded-[20px] border border-slate-100 bg-white px-4 py-3.5 shadow-[0_1px_2px_rgba(15,23,42,.04),0_10px_28px_-16px_rgba(15,23,42,.14)] transition-shadow hover:shadow-[0_1px_2px_rgba(15,23,42,.04),0_14px_32px_-14px_rgba(15,23,42,.18)]">
      <div className={`mb-2 flex h-8 w-8 items-center justify-center rounded-lg ${styles.bg} ${styles.text}`}>
        {icon}
      </div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-0.5 text-lg font-bold tabular-nums ${styles.text}`}>{value}</p>
    </div>
  );
}
