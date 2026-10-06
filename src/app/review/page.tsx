import Link from "next/link";
import { NavBar } from "@/components/nav-bar";
import { getPendingMatches, getUnmatchedBreakdown } from "@/lib/queries";
import { PendingMatchCard } from "./pending-match-card";
import { Card, SourceBadge, EmptyState } from "@/components/ui";
import { IconCheckCircle, IconInbox } from "@/components/icons";

export const dynamic = "force-dynamic";

const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });

export default async function ReviewPage() {
  const [pending, unmatchedBreakdown] = await Promise.all([
    getPendingMatches(),
    getUnmatchedBreakdown(),
  ]);
  const unmatchedTotal = unmatchedBreakdown.reduce((acc, r) => acc + r.count, 0);

  return (
    <div className="flex min-h-screen flex-col">
      <NavBar />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-slate-900">Revisión</h1>
          <p className="text-sm text-slate-500">Confirmá sugerencias o uní movimientos a mano</p>
        </div>

        <section className="mb-10">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">
            Sugerencias para confirmar <span className="text-slate-400">({pending.length})</span>
          </h2>
          {pending.length === 0 ? (
            <div className="rounded-xl border border-slate-200 bg-white">
              <EmptyState
                icon={<IconCheckCircle width={20} height={20} />}
                title="No hay sugerencias pendientes"
                description="Cuando el sistema encuentre coincidencias con baja certeza, van a aparecer acá para que las confirmes."
              />
            </div>
          ) : (
            <div className="space-y-3">
              {pending.map((p) => (
                <PendingMatchCard key={p.match.id} match={p.match} transactions={p.transactions} />
              ))}
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-1 text-sm font-semibold text-slate-900">
            Sin ningún match <span className="text-slate-400">({unmatchedTotal})</span>
          </h2>
          <p className="mb-3 text-xs text-slate-500">
            Les falta el comprobante o movimiento del otro lado para poder conciliar. Agrupados por fuente — click en
            una fila para ver el detalle mes a mes y unir a mano lo que corresponda.
          </p>
          <Card>
            {unmatchedBreakdown.length === 0 ? (
              <EmptyState icon={<IconInbox width={20} height={20} />} title="No hay nada sin match" />
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="px-5 py-2.5 font-medium">Fuente</th>
                    <th className="px-5 py-2.5 font-medium">Movimientos</th>
                    <th className="px-5 py-2.5 font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {unmatchedBreakdown.map((row) => (
                    <tr key={row.source} className="group border-t border-slate-100 hover:bg-slate-50/80">
                      <td className="p-0">
                        <Link href={`/sin-conciliar/${row.source}`} className="block px-5 py-3">
                          <SourceBadge source={row.source} />
                        </Link>
                      </td>
                      <td className="p-0">
                        <Link href={`/sin-conciliar/${row.source}`} className="block px-5 py-3 text-slate-600 group-hover:text-indigo-600">
                          {row.count}
                        </Link>
                      </td>
                      <td className="p-0">
                        <Link
                          href={`/sin-conciliar/${row.source}`}
                          className="block whitespace-nowrap px-5 py-3 font-medium tabular-nums text-slate-700"
                        >
                          {fmt.format(row.total)}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </section>
      </main>
    </div>
  );
}
