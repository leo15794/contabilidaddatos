import Link from "next/link";
import { notFound } from "next/navigation";
import { NavBar } from "@/components/nav-bar";
import { getBatchDetail } from "@/lib/queries";
import { Card, CardHeader, SourceBadge } from "@/components/ui";
import { IconArrowLeft } from "@/components/icons";
import { BatchTransactionsTable } from "../batch-transactions-table";

export const dynamic = "force-dynamic";

const fmtDateTime = new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short" });
const fmtDate = new Intl.DateTimeFormat("es-AR", { dateStyle: "short" });

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

        <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-5">
          <MiniStat label="Movimientos" value={String(stats.total)} tone="neutral" />
          <MiniStat label="Conciliados" value={String(stats.conciliados)} tone="positive" />
          <MiniStat label="Pendientes de revisar" value={String(stats.pendientes)} tone="warning" />
          <MiniStat label="Sin conciliar" value={String(stats.sinConciliar)} tone="neutral" />
          <MiniStat label="Categorizados" value={String(stats.categorizados)} tone="brand" />
        </div>

        <Card>
          <CardHeader
            title="Movimientos de este archivo"
            subtitle={
              stats.pendientes > 0 || stats.sinConciliar > 0
                ? "Los que no van a tener nunca una contraparte (comisiones, impuestos, intereses del resumen) se pueden marcar con una categoría en vez de dejarlos \"sin conciliar\"."
                : undefined
            }
          />
          <BatchTransactionsTable batchId={batch.id} batchAccountRef={batch.accountRef} rows={rows} />
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
  tone: "positive" | "neutral" | "warning" | "brand";
}) {
  const styles = {
    positive: { text: "text-emerald-600", bg: "bg-emerald-50" },
    neutral: { text: "text-slate-700", bg: "bg-slate-100" },
    warning: { text: "text-amber-600", bg: "bg-amber-50" },
    brand: { text: "text-violet-600", bg: "bg-violet-50" },
  }[tone];

  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3.5 shadow-sm">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold tabular-nums ${styles.text}`}>{value}</p>
    </div>
  );
}
