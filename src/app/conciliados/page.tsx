import Link from "next/link";
import { NavBar } from "@/components/nav-bar";
import { getAllResolvedMatches } from "@/lib/queries";
import { filterMatches, groupMatches, type MatchGroup, type MatchGroupKind } from "@/lib/match-groups";
import { parseAmountInput } from "@/lib/amounts";
import { ConfirmedMatchCard } from "./confirmed-match-card";
import { Card, EmptyState } from "@/components/ui";
import { IconArrowLeft, IconCheckCircle } from "@/components/icons";

export const dynamic = "force-dynamic";

const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });
const fmtMonth = new Intl.DateTimeFormat("es-AR", { month: "short", year: "numeric", timeZone: "UTC" });

// Con una búsqueda se muestran los cruces; más de esto no se lee y la página se pone lenta.
const MAX_RESULTS = 150;

const KINDS: { key: "todos" | MatchGroupKind; label: string }[] = [
  { key: "todos", label: "Todos" },
  { key: "proveedor", label: "Proveedores" },
  { key: "cliente", label: "Clientes" },
  { key: "otro", label: "Sin comprobante" },
];

const KIND_BADGE: Record<MatchGroupKind, string> = {
  proveedor: "bg-teal-50 text-teal-700",
  cliente: "bg-cyan-50 text-cyan-700",
  otro: "bg-slate-100 text-slate-600",
};

const MARGINS = [
  { value: "0", label: "Exacto" },
  { value: "0.01", label: "± 1 %" },
  { value: "0.05", label: "± 5 %" },
  { value: "0.1", label: "± 10 %" },
];

export default async function ConciliadosPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; importe?: string; margen?: string; tipo?: string; grupo?: string }>;
}) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim().slice(0, 100);
  const importe = sp.importe ?? "";
  const amount = parseAmountInput(importe);
  const margen = MARGINS.some((m) => m.value === sp.margen) ? sp.margen! : "0";
  const tipo = KINDS.find((k) => k.key === sp.tipo)?.key ?? "todos";
  const searching = q !== "" || amount !== undefined;

  const all = await getAllResolvedMatches();
  const rows = searching ? filterMatches(all, { text: q, amount, margin: Number(margen) }) : all;
  const groups = groupMatches(rows).filter((g) => tipo === "todos" || g.kind === tipo);
  const group = sp.grupo ? groups.find((g) => g.key === sp.grupo) : undefined;

  const params = (extra: Record<string, string>) => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (importe) p.set("importe", importe);
    if (margen !== "0") p.set("margen", margen);
    if (tipo !== "todos") p.set("tipo", tipo);
    for (const [k, v] of Object.entries(extra)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    const s = p.toString();
    return s ? `/conciliados?${s}` : "/conciliados";
  };

  return (
    <div className="flex min-h-screen flex-col">
      <NavBar />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <div className="mb-5">
          <h1 className="text-xl font-semibold text-slate-900">Conciliados</h1>
          <p className="text-sm text-slate-500">
            Todo lo que ya quedó cruzado, agrupado por proveedor o cliente. {all.length.toLocaleString("es-AR")} cruces en total.
          </p>
        </div>

        <form action="/conciliados" className="mb-4 flex flex-wrap items-end gap-2 rounded-2xl bg-white p-4 ring-1 ring-slate-200">
          {tipo !== "todos" && <input type="hidden" name="tipo" value={tipo} />}
          <label className="min-w-[200px] flex-[2] text-[11.5px] font-medium text-slate-500">
            Proveedor, CUIT, comprobante o descripción
            <input
              name="q"
              defaultValue={q}
              placeholder="Ej. Nosis, 30628455518, 1-783"
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-[13px] text-slate-800 outline-none focus:border-indigo-400"
            />
          </label>
          <label className="min-w-[140px] flex-1 text-[11.5px] font-medium text-slate-500">
            Importe
            <input
              name="importe"
              defaultValue={importe}
              inputMode="decimal"
              placeholder="Ej. 1.548.421,48"
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-[13px] tabular-nums text-slate-800 outline-none focus:border-indigo-400"
            />
          </label>
          <label className="text-[11.5px] font-medium text-slate-500">
            Margen
            <select
              name="margen"
              defaultValue={margen}
              className="mt-1 block rounded-lg border border-slate-200 bg-white px-2 py-2 text-[13px] text-slate-800"
            >
              {MARGINS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="rounded-xl bg-indigo-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-indigo-700"
          >
            Buscar
          </button>
          {searching && (
            <Link href={params({ q: "", importe: "", margen: "" })} className="px-2 py-2.5 text-xs font-medium text-slate-500 hover:text-slate-800">
              Limpiar
            </Link>
          )}
        </form>

        <div className="mb-5 flex flex-wrap gap-2 text-[12.5px] font-medium">
          {KINDS.map((k) => (
            <Link
              key={k.key}
              href={params({ tipo: k.key === "todos" ? "" : k.key, grupo: "" })}
              className={`rounded-full px-3 py-1.5 ${
                tipo === k.key ? "bg-slate-900 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
              }`}
            >
              {k.label}
            </Link>
          ))}
        </div>

        {all.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white">
            <EmptyState
              icon={<IconCheckCircle width={20} height={20} />}
              title="Todavía no hay nada conciliado"
              description="Cuando confirmes sugerencias en Revisión, o el motor cruce algo automático, va a aparecer acá."
            />
          </div>
        ) : sp.grupo ? (
          <GroupDetail group={group} backHref={params({ grupo: "" })} />
        ) : searching ? (
          <SearchResults groups={groups} groupHref={(key) => params({ grupo: key })} />
        ) : (
          <GroupTable groups={groups} groupHref={(key) => params({ grupo: key })} />
        )}
      </main>
    </div>
  );
}

function KindBadge({ kind }: { kind: MatchGroupKind }) {
  const label = kind === "proveedor" ? "Proveedor" : kind === "cliente" ? "Cliente" : "Sin comprobante";
  return <span className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${KIND_BADGE[kind]}`}>{label}</span>;
}

function GroupTable({ groups, groupHref }: { groups: MatchGroup[]; groupHref: (key: string) => string }) {
  if (groups.length === 0) return <p className="text-sm text-slate-500">No hay cruces de este tipo.</p>;
  return (
    <Card>
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-slate-400">
          <tr>
            <th className="px-5 py-2.5 font-medium">Proveedor / cliente</th>
            <th className="px-5 py-2.5 font-medium">Cruces</th>
            <th className="px-5 py-2.5 font-medium">Total</th>
            <th className="hidden px-5 py-2.5 font-medium sm:table-cell">Último</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const href = groupHref(g.key);
            return (
              <tr key={g.key} className="group border-t border-slate-100 hover:bg-slate-50/80">
                <td className="p-0">
                  <Link href={href} className="flex flex-wrap items-center gap-2 px-5 py-3 text-slate-800 group-hover:text-indigo-600">
                    <span className="font-medium">{g.label}</span>
                    <KindBadge kind={g.kind} />
                    {g.cuit && <span className="text-xs text-slate-400">CUIT {g.cuit}</span>}
                  </Link>
                </td>
                <td className="p-0">
                  <Link href={href} className="block px-5 py-3 text-slate-600">
                    {g.count}
                  </Link>
                </td>
                <td className="p-0">
                  <Link href={href} className="block whitespace-nowrap px-5 py-3 font-medium tabular-nums text-slate-700">
                    {fmt.format(g.total)}
                  </Link>
                </td>
                <td className="hidden p-0 sm:table-cell">
                  <Link href={href} className="block whitespace-nowrap px-5 py-3 text-xs text-slate-500">
                    {fmtMonth.format(g.last)}
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

function GroupHeading({ group, href }: { group: MatchGroup; href?: string }) {
  const title = (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-[15px] font-semibold text-slate-900">{group.label}</span>
      <KindBadge kind={group.kind} />
      {group.cuit && <span className="text-xs text-slate-400">CUIT {group.cuit}</span>}
    </span>
  );
  return (
    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
      {href ? (
        <Link href={href} className="hover:text-indigo-600">
          {title}
        </Link>
      ) : (
        title
      )}
      <span className="text-xs tabular-nums text-slate-500">
        {group.count} {group.count === 1 ? "cruce" : "cruces"} · {fmt.format(group.total)}
      </span>
    </div>
  );
}

function GroupDetail({ group, backHref }: { group: MatchGroup | undefined; backHref: string }) {
  return (
    <div>
      <Link href={backHref} className="mb-4 inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-800">
        <IconArrowLeft width={13} height={13} />
        Volver a la lista
      </Link>
      {!group ? (
        <p className="text-sm text-slate-500">No hay cruces de este proveedor o cliente con la búsqueda actual.</p>
      ) : (
        <>
          <GroupHeading group={group} />
          <div className="space-y-3">
            {group.matches.map((m) => (
              <ConfirmedMatchCard key={m.match.id} match={m.match} transactions={m.transactions} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SearchResults({ groups, groupHref }: { groups: MatchGroup[]; groupHref: (key: string) => string }) {
  const total = groups.reduce((acc, g) => acc + g.count, 0);
  if (total === 0) return <p className="text-sm text-slate-500">No hay cruces con esos datos.</p>;

  // Se muestran grupos enteros hasta llegar al tope.
  let shown = 0;
  const visible: MatchGroup[] = [];
  for (const g of groups) {
    if (shown >= MAX_RESULTS) break;
    visible.push(g);
    shown += g.count;
  }

  return (
    <div>
      <p className="mb-4 text-xs text-slate-500">
        {total} {total === 1 ? "cruce" : "cruces"} en {groups.length} {groups.length === 1 ? "grupo" : "grupos"}
        {visible.length < groups.length && ` — se muestran los ${visible.length} grupos con más plata; afiná la búsqueda para ver el resto`}
        .
      </p>
      <div className="space-y-7">
        {visible.map((g) => (
          <section key={g.key}>
            <GroupHeading group={g} href={groupHref(g.key)} />
            <div className="space-y-3">
              {g.matches.map((m) => (
                <ConfirmedMatchCard key={m.match.id} match={m.match} transactions={m.transactions} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
