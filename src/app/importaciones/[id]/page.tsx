import Link from "next/link";
import { notFound } from "next/navigation";
import { NavBar } from "@/components/nav-bar";
import { getBatchDetail } from "@/lib/queries";
import { Card, CardHeader, SourceBadge, Amount } from "@/components/ui";
import { IconArrowLeft } from "@/components/icons";

export const dynamic = "force-dynamic";

const fmtDateTime = new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short" });
const fmtDate = new Intl.DateTimeFormat("es-AR", { dateStyle: "short" });

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  auto: { bg: "bg-sky-100", text: "text-sky-800", label: "Conciliado (automático)" },
  confirmed: { bg: "bg-emerald-100", text: "text-emerald-800", label: "Conciliado (confirmado)" },
  manual: { bg: "bg-indigo-100", text: "text-indigo-800", label: "Conciliado (manual)" },
  pending: { bg: "bg-amber-100", text: "text-amber-800", label: "Pendiente de revisar" },
};
const NONE_STYLE = { bg: "bg-slate-100", text: "text-slate-600", label: "Sin conciliar" };

export default async function ImportBatchDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const batchId = Number(id);
  if (!Number.isFinite(batchId)) notFound();

  const detail = await getBatchDetail(batchId);
  if (!detail) notFound();

  const { batch, rows, stats } = detail;

  return (
    <div className="flex min-h-screen flex-col">
      <NavBar />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <Link
          href="/importaciones"
          className="mb-4 inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-800"
        >
          <IconArrowLeft width={13} height={13} />
          Volver a Importaciones
        </Link>

        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="break-all text-xl font-semibold text-slate-900">{batch.filename}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-500">
              <SourceBadge source={batch.source} />
              {batch.accountRef && <span>· {batch.accountRef}</span>}
              <span>· subido {fmtDateTime.format(batch.importedAt)}</span>
              {batch.statementDate && <span>· resumen del {fmtDate.format(batch.statementDate)}</span>}
            </p>
          </div>
        </div>

        <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <MiniStat label="Movimientos" value={String(stats.total)} tone="neutral" />
          <MiniStat label="Conciliados" value={String(stats.conciliados)} tone="positive" />
          <MiniStat label="Pendientes de revisar" value={String(stats.pendientes)} tone="warning" />
          <MiniStat label="Sin conciliar" value={String(stats.sinConciliar)} tone="neutral" />
        </div>

        <Card>
          <CardHeader
            title="Movimientos de este archivo"
            subtitle={
              stats.pendientes > 0 || stats.sinConciliar > 0
                ? "Los que no están conciliados se pueden resolver desde Revisión."
                : undefined
            }
          />
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-5 py-2.5 font-medium">Fecha</th>
                <th className="px-5 py-2.5 font-medium">Descripción</th>
                <th className="px-5 py-2.5 font-medium">Importe</th>
                <th className="px-5 py-2.5 font-medium">Estado</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ txn, matchStatus }) => {
                const style = (matchStatus && STATUS_STYLES[matchStatus]) || NONE_STYLE;
                return (
                  <tr key={txn.id} className="border-t border-slate-100 hover:bg-slate-50/80">
                    <td className="whitespace-nowrap px-5 py-3 text-slate-500">{fmtDate.format(txn.date)}</td>
                    <td className="px-5 py-3 text-slate-700">
                      {txn.description}
                      {txn.accountRef && txn.accountRef !== batch.accountRef && (
                        <span className="ml-1.5 text-xs text-slate-400">({txn.accountRef})</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3">
                      <Amount value={Number(txn.amount)} />
                    </td>
                    <td className="whitespace-nowrap px-5 py-3">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${style.bg} ${style.text}`}
                      >
                        {style.label}
                      </span>
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

function MiniStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "positive" | "neutral" | "warning";
}) {
  const styles = {
    positive: { text: "text-emerald-600", bg: "bg-emerald-50" },
    neutral: { text: "text-slate-700", bg: "bg-slate-100" },
    warning: { text: "text-amber-600", bg: "bg-amber-50" },
  }[tone];

  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3.5 shadow-sm">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold tabular-nums ${styles.text}`}>{value}</p>
    </div>
  );
}
