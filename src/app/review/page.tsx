import { NavBar } from "@/components/nav-bar";
import { getPendingMatches, getUnmatchedTransactions } from "@/lib/queries";
import { PendingMatchCard } from "./pending-match-card";
import { UnmatchedList } from "./unmatched-list";
import { EmptyState } from "@/components/ui";
import { IconCheckCircle } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const [pending, unmatched] = await Promise.all([
    getPendingMatches(),
    getUnmatchedTransactions(),
  ]);

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
            Sin ningún match <span className="text-slate-400">({unmatched.length})</span>
          </h2>
          <p className="mb-3 text-xs text-slate-500">
            Seleccioná dos o más movimientos que correspondan al mismo hecho y unílos a mano.
          </p>
          <UnmatchedList transactions={unmatched} />
        </section>
      </main>
    </div>
  );
}
