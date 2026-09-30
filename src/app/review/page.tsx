import { NavBar } from "@/components/nav-bar";
import { getPendingMatches, getUnmatchedTransactions } from "@/lib/queries";
import { PendingMatchCard } from "./pending-match-card";
import { UnmatchedList } from "./unmatched-list";

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
        <h1 className="mb-6 text-lg font-semibold text-slate-900">Revisión</h1>

        <section className="mb-10">
          <h2 className="mb-3 text-sm font-medium text-slate-900">
            Sugerencias para confirmar ({pending.length})
          </h2>
          {pending.length === 0 ? (
            <p className="text-sm text-slate-500">No hay sugerencias pendientes.</p>
          ) : (
            <div className="space-y-3">
              {pending.map((p) => (
                <PendingMatchCard key={p.match.id} match={p.match} transactions={p.transactions} />
              ))}
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-sm font-medium text-slate-900">
            Sin ningún match ({unmatched.length})
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
