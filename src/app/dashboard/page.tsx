import { NavBar } from "@/components/nav-bar";
import { getDashboardSummary } from "@/lib/queries";
import { ReconcileButton } from "./reconcile-button";

export const dynamic = "force-dynamic";

const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });
const fmtDateTime = new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short" });

const SOURCE_LABELS: Record<string, string> = {
  bank: "Banco",
  card: "Tarjeta",
  afip_issued: "AFIP emitidas",
  afip_received: "AFIP recibidas",
};

export default async function DashboardPage() {
  const summary = await getDashboardSummary();

  return (
    <div className="flex min-h-screen flex-col">
      <NavBar />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-lg font-semibold text-slate-900">Dashboard</h1>
          <ReconcileButton />
        </div>

        <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Ingresos" value={fmt.format(summary.ingresos)} tone="positive" />
          <Stat label="Egresos" value={fmt.format(summary.egresos)} tone="negative" />
          <Stat label="Conciliado" value={`${summary.conciliadoPct}%`} tone="neutral" />
          <Stat
            label="Pendientes de revisar"
            value={String(summary.pendingReviewCount)}
            tone={summary.pendingReviewCount > 0 ? "warning" : "neutral"}
          />
        </div>

        <div className="mb-8 rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-3">
            <h2 className="text-sm font-medium text-slate-900">Por fuente</h2>
          </div>
          <table className="w-full text-sm">
            <thead className="text-left text-slate-500">
              <tr>
                <th className="px-4 py-2 font-normal">Fuente</th>
                <th className="px-4 py-2 font-normal">Movimientos</th>
                <th className="px-4 py-2 font-normal">Total</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(summary.bySource).map(([source, data]) => (
                <tr key={source} className="border-t border-slate-100">
                  <td className="px-4 py-2">{SOURCE_LABELS[source] ?? source}</td>
                  <td className="px-4 py-2">{data.count}</td>
                  <td className={`px-4 py-2 ${data.total < 0 ? "text-red-600" : "text-emerald-600"}`}>
                    {fmt.format(data.total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-3">
            <h2 className="text-sm font-medium text-slate-900">Importaciones recientes</h2>
          </div>
          {summary.recentBatches.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-500">
              Todavía no importaste nada.{" "}
              <a href="/import" className="underline">
                Empezá acá
              </a>
              .
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-normal">Fecha</th>
                  <th className="px-4 py-2 font-normal">Fuente</th>
                  <th className="px-4 py-2 font-normal">Archivo</th>
                  <th className="px-4 py-2 font-normal">Filas</th>
                </tr>
              </thead>
              <tbody>
                {summary.recentBatches.map((b) => (
                  <tr key={b.id} className="border-t border-slate-100">
                    <td className="px-4 py-2 text-slate-500">{fmtDateTime.format(b.importedAt)}</td>
                    <td className="px-4 py-2">{SOURCE_LABELS[b.source] ?? b.source}</td>
                    <td className="px-4 py-2">{b.filename}</td>
                    <td className="px-4 py-2">{b.rowCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "positive" | "negative" | "neutral" | "warning";
}) {
  const toneClass = {
    positive: "text-emerald-600",
    negative: "text-red-600",
    neutral: "text-slate-900",
    warning: "text-amber-600",
  }[tone];

  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}
