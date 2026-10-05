import Link from "next/link";
import { notFound } from "next/navigation";
import { NavBar } from "@/components/nav-bar";
import { getBatchDetail } from "@/lib/queries";
import { Card, CardHeader, SourceBadge, StatCard } from "@/components/ui";
import { IconArrowLeft, IconInbox, IconCheckCircle, IconClock, IconFileText } from "@/components/icons";
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
          <StatCard label="Movimientos" value={String(stats.total)} tone="neutral" icon={<IconInbox width={17} height={17} />} />
          <StatCard
            label="Conciliados"
            value={String(stats.conciliados)}
            tone="success"
            icon={<IconCheckCircle width={17} height={17} />}
          />
          <StatCard
            label="Pendientes de revisar"
            value={String(stats.pendientes)}
            tone={stats.pendientes > 0 ? "warning" : "neutral"}
            icon={<IconClock width={17} height={17} />}
          />
          <StatCard label="Sin conciliar" value={String(stats.sinConciliar)} tone="neutral" icon={<IconInbox width={17} height={17} />} />
          <StatCard
            label="Categorizados"
            value={String(stats.categorizados)}
            tone="neutral"
            icon={<IconFileText width={17} height={17} />}
          />
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
