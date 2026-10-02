import { NavBar } from "@/components/nav-bar";
import { getConfirmedMatches } from "@/lib/queries";
import { ConfirmedMatchCard } from "./confirmed-match-card";
import { EmptyState } from "@/components/ui";
import { IconCheckCircle } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function ConciliadosPage() {
  const { matches, totalCount } = await getConfirmedMatches(200);

  return (
    <div className="flex min-h-screen flex-col">
      <NavBar />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-slate-900">Conciliados</h1>
          <p className="text-sm text-slate-500">
            Todo lo que ya quedó cruzado — confirmado a mano, cargado manualmente, o resuelto solo por el motor.
          </p>
        </div>

        <div className="mb-4 text-xs text-slate-500">
          Mostrando {matches.length} de {totalCount} {totalCount === 1 ? "match" : "matches"}
          {matches.length < totalCount && " (los más recientes primero)"}
        </div>

        {matches.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white">
            <EmptyState
              icon={<IconCheckCircle width={20} height={20} />}
              title="Todavía no hay nada conciliado"
              description="Cuando confirmes sugerencias en Revisión, o el motor cruce algo automático, va a aparecer acá."
            />
          </div>
        ) : (
          <div className="space-y-3">
            {matches.map((m) => (
              <ConfirmedMatchCard key={m.match.id} match={m.match} transactions={m.transactions} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
