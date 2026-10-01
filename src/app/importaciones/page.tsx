import Link from "next/link";
import { NavBar } from "@/components/nav-bar";
import { getImportBatchesWithStats } from "@/lib/queries";
import { Card, SourceBadge, EmptyState } from "@/components/ui";
import { IconInbox } from "@/components/icons";

export const dynamic = "force-dynamic";

const fmtDateTime = new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short" });
const fmtDate = new Intl.DateTimeFormat("es-AR", { dateStyle: "short" });

export default async function ImportacionesPage() {
  const batches = await getImportBatchesWithStats();

  return (
    <div className="flex min-h-screen flex-col">
      <NavBar />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-slate-900">Importaciones</h1>
          <p className="text-sm text-slate-500">
            Todos los archivos subidos hasta ahora — resúmenes de tarjeta, movimientos de banco,
            comprobantes AFIP y tickets. Entrá a uno para ver movimiento por movimiento qué quedó
            conciliado.
          </p>
        </div>

        {batches.length === 0 ? (
          <Card>
            <EmptyState
              icon={<IconInbox width={20} height={20} />}
              title="Todavía no importaste nada"
              description="Subí tu primer archivo de banco, tarjeta o AFIP para empezar a conciliar."
              action={
                <a
                  href="/import"
                  className="mt-2 inline-flex rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
                >
                  Empezar a importar
                </a>
              }
            />
          </Card>
        ) : (
          <Card>
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Subido</th>
                  <th className="px-5 py-2.5 font-medium">Fuente</th>
                  <th className="px-5 py-2.5 font-medium">Archivo</th>
                  <th className="px-5 py-2.5 font-medium">Cuenta</th>
                  <th className="px-5 py-2.5 font-medium">Fecha del resumen</th>
                  <th className="px-5 py-2.5 font-medium">Filas</th>
                  <th className="px-5 py-2.5 font-medium">Conciliación</th>
                  <th className="px-5 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {batches.map(({ batch, stats }) => (
                  <tr key={batch.id} className="border-t border-slate-100 hover:bg-slate-50/80">
                    <td className="px-5 py-3 text-slate-500">{fmtDateTime.format(batch.importedAt)}</td>
                    <td className="px-5 py-3">
                      <SourceBadge source={batch.source} />
                    </td>
                    <td className="max-w-[220px] truncate px-5 py-3 text-slate-700" title={batch.filename}>
                      {batch.filename}
                    </td>
                    <td className="px-5 py-3 text-slate-600">{batch.accountRef ?? "—"}</td>
                    <td className="px-5 py-3 text-slate-600">
                      {batch.statementDate ? fmtDate.format(batch.statementDate) : "—"}
                    </td>
                    <td className="px-5 py-3 text-slate-600">{stats.total}</td>
                    <td className="px-5 py-3">
                      <ConciliationBar stats={stats} />
                    </td>
                    <td className="px-5 py-3 text-right">
                      <Link
                        href={`/importaciones/${batch.id}`}
                        className="text-xs font-medium text-indigo-600 hover:text-indigo-800"
                      >
                        Ver movimientos
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </main>
    </div>
  );
}

function ConciliationBar({
  stats,
}: {
  stats: { total: number; conciliados: number; pendientes: number; sinConciliar: number };
}) {
  if (stats.total === 0) {
    return <span className="text-xs text-slate-400">Sin movimientos</span>;
  }
  const pct = Math.round((stats.conciliados / stats.total) * 100);
  return (
    <div className="flex min-w-[140px] items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
      </div>
      <span className="shrink-0 text-xs tabular-nums text-slate-500">
        {stats.conciliados}/{stats.total}
      </span>
      {stats.pendientes > 0 && (
        <span className="shrink-0 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
          {stats.pendientes} rev.
        </span>
      )}
    </div>
  );
}
