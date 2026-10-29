import Link from "next/link";
import { NavBar } from "@/components/nav-bar";
import { getPendingMatches, getUnmatchedBreakdown } from "@/lib/queries";
import { SOURCE_STYLES } from "@/components/ui";
import { ReviewQueue } from "./review-queue";
import { toSuggestionView, type SuggestionView } from "./suggestion-view";

export const dynamic = "force-dynamic";

const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });

const FILTERS: { key: string; label: string; test: (s: SuggestionView) => boolean }[] = [
  { key: "todas", label: "Todas", test: () => true },
  { key: "tarjeta", label: "Tarjeta", test: (s) => s.kind === "tarjeta" },
  { key: "banco", label: "Banco", test: (s) => s.kind === "banco" },
  { key: "efectivo", label: "Efectivo", test: (s) => s.kind === "efectivo" },
  { key: "varias", label: "Varias facturas", test: (s) => s.multi },
];

export default async function ReviewPage({ searchParams }: { searchParams: Promise<{ tipo?: string }> }) {
  const { tipo } = await searchParams;
  const [pending, unmatchedBreakdown] = await Promise.all([getPendingMatches(), getUnmatchedBreakdown()]);

  const all = pending.map((p) => toSuggestionView(p.match, p.transactions));
  const filter = FILTERS.find((f) => f.key === tipo) ?? FILTERS[0];
  const shown = all.filter(filter.test);
  const unmatchedTotal = unmatchedBreakdown.reduce((acc, r) => acc + r.count, 0);

  return (
    <div className="flex min-h-screen flex-col">
      <NavBar />
      <main className="mx-auto w-full max-w-[1180px] flex-1 px-5 py-7 lg:px-9">
        <div>
          <p className="text-[12.5px] font-medium text-slate-400">Conciliar</p>
          <h1 className="mt-1 text-[26px] font-bold tracking-tight text-slate-900">Revisar sugerencias</h1>
          <p className="mt-1 text-[13px] text-slate-500">
            El motor encontró una pareja probable para cada una. Confirmá si es correcta o rechazala para que no la vuelva a
            proponer.
          </p>
        </div>

        <div className="mt-5 flex flex-wrap gap-2 text-[12.5px] font-medium">
          {FILTERS.map((f) => {
            const count = all.filter(f.test).length;
            if (f.key !== "todas" && count === 0) return null;
            const activeFilter = f.key === filter.key;
            return (
              <Link
                key={f.key}
                href={f.key === "todas" ? "/review" : `/review?tipo=${f.key}`}
                className={`rounded-full px-3 py-1.5 ${
                  activeFilter ? "bg-slate-900 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
                }`}
              >
                {f.label} · {count}
              </Link>
            );
          })}
        </div>

        <div className="mt-4">
          {/* key: al cambiar de filtro la cola arranca de nuevo desde la primera */}
          <ReviewQueue key={filter.key} suggestions={shown} />
        </div>

        <section id="sin-conciliar" className="mt-10 scroll-mt-6">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-[17px] font-bold tracking-tight text-slate-900">
                Sin conciliar <span className="font-semibold text-slate-400">· {unmatchedTotal.toLocaleString("es-AR")}</span>
              </h2>
              <p className="mt-0.5 text-[12.5px] text-slate-500">
                Movimientos sin pareja: les falta la factura o el pago del otro lado. Entrá a una fuente para verlos mes a mes y
                unirlos a mano.
              </p>
            </div>
          </div>
          {unmatchedBreakdown.length === 0 ? (
            <p className="mt-4 rounded-2xl bg-white px-6 py-8 text-center text-[13px] text-slate-500 ring-1 ring-slate-200">
              No hay nada sin conciliar.
            </p>
          ) : (
            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {unmatchedBreakdown.map((row) => {
                const style = SOURCE_STYLES[row.source] ?? { label: row.source, dot: "bg-slate-400" };
                return (
                  <Link
                    key={row.source}
                    href={`/sin-conciliar/${row.source}`}
                    className="group rounded-2xl bg-white p-4 ring-1 ring-slate-200 transition-shadow hover:shadow-md"
                  >
                    <p className="flex items-center gap-2 text-[12.5px] font-medium text-slate-600">
                      <i className={`h-2 w-2 rounded-full ${style.dot}`} />
                      {style.label}
                    </p>
                    <p className="mt-2 text-[24px] font-extrabold tabular-nums text-slate-900">{row.count}</p>
                    <p className="text-[12px] tabular-nums text-slate-500">{fmt.format(row.total)}</p>
                    <p className="mt-2 text-[12px] font-semibold text-indigo-600 group-hover:text-indigo-700">Ver detalle →</p>
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
