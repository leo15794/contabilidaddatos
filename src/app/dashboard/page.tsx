import Link from "next/link";
import { NavBar } from "@/components/nav-bar";
import { getDashboardSummary } from "@/lib/queries";
import { ReconcileButton } from "./reconcile-button";
import { Card, CardHeader, SourceBadge, Amount, EmptyState } from "@/components/ui";
import {
  IconArrowUpRight,
  IconArrowDownRight,
  IconCheckCircle,
  IconClock,
  IconAlertTriangle,
  IconInbox,
  IconFileText,
} from "@/components/icons";

export const dynamic = "force-dynamic";

const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });
const fmtDateTime = new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short" });

const SOURCE_LABELS: Record<string, string> = {
  bank: "Banco",
  card: "Tarjeta",
  afip_issued: "AFIP emitidas",
  afip_received: "AFIP recibidas",
  ticket: "Ticket (WhatsApp)",
};

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

  const summary = await getDashboardSummary({ from, to });

  return (
    <div className="flex min-h-screen flex-col">
      <NavBar />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">Dashboard</h1>
            <p className="text-sm text-slate-500">Estado general de la conciliación</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <form className="flex items-end gap-2" action="/dashboard" method="GET">
              <label className="flex flex-col text-xs text-slate-500">
                Desde
                <input
                  type="date"
                  name="from"
                  defaultValue={fromStr ?? ""}
                  className="mt-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                />
              </label>
              <label className="flex flex-col text-xs text-slate-500">
                Hasta
                <input
                  type="date"
                  name="to"
                  defaultValue={toStr ?? ""}
                  className="mt-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-slate-700 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                />
              </label>
              <button
                type="submit"
                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
              >
                Filtrar
              </button>
              {hasFilter && (
                <a
                  href="/dashboard"
                  className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-100"
                >
                  Limpiar
                </a>
              )}
            </form>
            <ReconcileButton />
          </div>
        </div>

        {hasFilter && (
          <p className="-mt-3 mb-6 text-xs text-slate-500">
            {datesSwapped && (
              <span className="mr-1 font-medium text-amber-600">
                "Desde" estaba después de "Hasta", así que se invirtieron solos —
              </span>
            )}
            Mostrando movimientos {from ? `desde ${from.toLocaleDateString("es-AR")}` : ""}
            {from && to ? " " : ""}
            {to ? `hasta ${to.toLocaleDateString("es-AR")}` : ""}. "Importaciones recientes" sigue
            mostrando los últimos archivos subidos en general, sin filtrar.
          </p>
        )}

        <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
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
            tone="brand"
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
          <Stat
            label="Categorizados (sin conciliación)"
            value={String(summary.categorizadosCount)}
            tone="violet"
            icon={<IconFileText width={17} height={17} />}
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
            title="Importaciones recientes"
            action={
              <Link href="/importaciones" className="text-xs font-medium text-indigo-600 hover:text-indigo-800">
                Ver todas →
              </Link>
            }
          />
          {summary.recentBatches.length === 0 ? (
            <EmptyState
              icon={<IconInbox width={20} height={20} />}
              title="Todavía no importaste nada"
              description={
                <>
                  Subí tu primer archivo de banco, tarjeta o AFIP para empezar a conciliar.
                </>
              }
              action={
                <a
                  href="/import"
                  className="mt-2 inline-flex rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
                >
                  Empezar a importar
                </a>
              }
            />
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Fecha</th>
                  <th className="px-5 py-2.5 font-medium">Fuente</th>
                  <th className="px-5 py-2.5 font-medium">Archivo</th>
                  <th className="px-5 py-2.5 font-medium">Filas</th>
                </tr>
              </thead>
              <tbody>
                {summary.recentBatches.map((b) => (
                  <tr key={b.id} className="border-t border-slate-100 hover:bg-slate-50/80">
                    <td className="px-5 py-3 text-slate-500">{fmtDateTime.format(b.importedAt)}</td>
                    <td className="px-5 py-3">
                      <SourceBadge source={b.source} />
                    </td>
                    <td className="px-5 py-3 text-slate-700">{b.filename}</td>
                    <td className="px-5 py-3 text-slate-600">{b.rowCount}</td>
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
  tone: "positive" | "negative" | "brand" | "neutral" | "warning" | "violet";
  icon: React.ReactNode;
}) {
  const styles = {
    positive: { text: "text-emerald-600", bg: "bg-emerald-50" },
    negative: { text: "text-rose-600", bg: "bg-rose-50" },
    brand: { text: "text-indigo-600", bg: "bg-indigo-50" },
    neutral: { text: "text-slate-700", bg: "bg-slate-100" },
    warning: { text: "text-amber-600", bg: "bg-amber-50" },
    violet: { text: "text-violet-600", bg: "bg-violet-50" },
  }[tone];

  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3.5 shadow-sm transition-shadow hover:shadow-md">
      <div className={`mb-2 flex h-8 w-8 items-center justify-center rounded-lg ${styles.bg} ${styles.text}`}>
        {icon}
      </div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold tabular-nums ${styles.text}`}>{value}</p>
    </div>
  );
}
