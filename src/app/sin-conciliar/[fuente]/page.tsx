import Link from "next/link";
import { notFound } from "next/navigation";
import { NavBar } from "@/components/nav-bar";
import { getUnmatchedAll, getUnmatchedDetail, UNMATCHED_SOURCES, type UnmatchedSource } from "@/lib/queries";
import { groupOf, groupTransactions } from "@/lib/unmatched-groups";
import { netAmount } from "@/lib/amounts";
import { Card, CardHeader, SourceBadge, StatCard } from "@/components/ui";
import { IconArrowLeft, IconInbox, IconFileText } from "@/components/icons";
import { UnmatchedList } from "@/app/review/unmatched-list";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });
const fmtMonth = new Intl.DateTimeFormat("es-AR", { month: "short", year: "numeric", timeZone: "UTC" });
const MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

function monthLabel(ym: string) {
  const [year, month] = ym.split("-");
  const idx = Number(month) - 1;
  return `${MESES[idx] ?? month} ${year}`;
}

function isUnmatchedSource(value: string): value is UnmatchedSource {
  return (UNMATCHED_SOURCES as readonly string[]).includes(value);
}

const GROUP_COLUMN: Record<UnmatchedSource, string> = {
  afip_received: "Proveedor",
  afip_issued: "Cliente",
  card: "Comercio",
  bank: "Destinatario / origen",
  ticket: "Comercio",
  retention: "Agente de retención",
  cash: "Comercio",
};

export default async function SinConciliarDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ fuente: string }>;
  searchParams: Promise<{ page?: string; vista?: string; grupo?: string }>;
}) {
  const { fuente } = await params;
  if (!isUnmatchedSource(fuente)) notFound();

  const { page: pageStr, vista: vistaStr, grupo } = await searchParams;
  const page = Math.max(1, Number(pageStr) || 1);
  // Por defecto se muestra agrupado por proveedor/comercio; elegir un grupo o
  // la pestaña "Todos los movimientos" lleva al detalle.
  const vista = grupo || vistaStr === "detalle" ? "detalle" : "grupos";

  const detail = await getUnmatchedDetail(fuente, { page, pageSize: PAGE_SIZE });
  const all = vista === "grupos" || grupo ? await getUnmatchedAll(fuente) : [];
  const groups = vista === "grupos" ? groupTransactions(all) : [];

  // Con un grupo elegido, el detalle sale de ese grupo (paginado en memoria).
  const grupoRows = grupo ? all.filter((t) => groupOf(t).key === grupo) : null;
  const grupoLabel = grupoRows && grupoRows[0] ? groupOf(grupoRows[0]).label : grupo;
  const rows = grupoRows ? grupoRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : detail.rows;
  const totalCount = grupoRows ? grupoRows.length : detail.totalCount;
  const pageCount = grupoRows ? Math.max(1, Math.ceil(grupoRows.length / PAGE_SIZE)) : detail.pageCount;

  const pageHref = (p: number) =>
    `/sin-conciliar/${fuente}?vista=detalle${grupo ? `&grupo=${encodeURIComponent(grupo)}` : ""}&page=${p}`;
  const exportHref = `/api/sin-conciliar/${fuente}/export${grupo ? `?grupo=${encodeURIComponent(grupo)}` : ""}`;

  const tabClass = (active: boolean) =>
    `rounded-lg px-3 py-1.5 text-xs font-medium ${
      active ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-100"
    }`;

  return (
    <div className="flex min-h-screen flex-col">
      <NavBar />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <Link
          href={grupo ? `/sin-conciliar/${fuente}` : "/review"}
          className="mb-4 inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-800"
        >
          <IconArrowLeft width={13} height={13} />
          {grupo ? "Volver a la lista por proveedor/comercio" : "Volver a Revisión"}
        </Link>

        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <SourceBadge source={fuente} />
            <h1 className="text-xl font-semibold text-slate-900">
              {grupo ? grupoLabel : "Sin ningún match"}
            </h1>
          </div>
          <a
            href={exportHref}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Exportar a Excel
          </a>
        </div>
        <p className="-mt-4 mb-6 text-sm text-slate-500">
          Movimientos sin categoría y sin match — les falta el comprobante o movimiento del otro lado para poder
          conciliar.
        </p>

        <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
          <StatCard
            label="Movimientos"
            value={String(totalCount)}
            tone="neutral"
            icon={<IconInbox width={17} height={17} />}
          />
          <StatCard
            label="Total"
            value={fmt.format(
              grupoRows ? grupoRows.reduce((acc, t) => acc + netAmount(t.source, t.amount), 0) : detail.totalAmount,
            )}
            tone="neutral"
            icon={<IconFileText width={17} height={17} />}
          />
          <StatCard
            label={grupo ? "Desde" : "Meses con movimientos"}
            value={
              grupoRows && grupoRows.length > 0
                ? fmtMonth.format(grupoRows[grupoRows.length - 1].date)
                : String(detail.monthly.length)
            }
            tone="neutral"
            icon={<IconInbox width={17} height={17} />}
          />
        </div>

        {!grupo && (
          <div className="mb-6 flex gap-2">
            <Link href={`/sin-conciliar/${fuente}`} className={tabClass(vista === "grupos")}>
              Por {GROUP_COLUMN[fuente].toLowerCase().split(" ")[0]}
            </Link>
            <Link href={`/sin-conciliar/${fuente}?vista=detalle`} className={tabClass(vista === "detalle")}>
              Todos los movimientos
            </Link>
          </div>
        )}

        {vista === "grupos" && (
          <Card className="mb-6">
            <CardHeader
              title={`Por ${GROUP_COLUMN[fuente].toLowerCase()}`}
              subtitle="Ordenado por plata (el más grande primero). Click en una fila para ver sus movimientos y unirlos a mano."
            />
            {groups.length === 0 ? (
              <p className="px-6 pb-5 text-sm text-slate-500">No hay nada sin match en esta fuente.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-slate-400">
                  <tr>
                    <th className="px-5 py-2.5 font-medium">{GROUP_COLUMN[fuente]}</th>
                    <th className="px-5 py-2.5 font-medium">Movimientos</th>
                    <th className="px-5 py-2.5 font-medium">Total</th>
                    <th className="hidden px-5 py-2.5 font-medium sm:table-cell">Período</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => {
                    const href = `/sin-conciliar/${fuente}?grupo=${encodeURIComponent(g.key)}`;
                    return (
                      <tr key={g.key} className="group border-t border-slate-100 hover:bg-slate-50/80">
                        <td className="p-0">
                          <Link href={href} className="block px-5 py-3 text-slate-800 group-hover:text-indigo-600">
                            <span className="font-medium">{g.label}</span>
                            {g.cuit && <span className="ml-2 text-xs text-slate-400">CUIT {g.cuit}</span>}
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
                            {fmtMonth.format(g.first)} – {fmtMonth.format(g.last)}
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>
        )}

        {vista === "detalle" && !grupo && detail.monthly.length > 0 && (
          <Card className="mb-6">
            <CardHeader title="Por mes" subtitle="Cuántos hay y cuánto suman, mes a mes (el más reciente primero)." />
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Mes</th>
                  <th className="px-5 py-2.5 font-medium">Movimientos</th>
                  <th className="px-5 py-2.5 font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {detail.monthly.map((m) => (
                  <tr key={m.month} className="border-t border-slate-100 hover:bg-slate-50/80">
                    <td className="px-5 py-3 text-slate-700">{monthLabel(m.month)}</td>
                    <td className="px-5 py-3 text-slate-600">{m.count}</td>
                    <td className="whitespace-nowrap px-5 py-3 font-medium tabular-nums text-slate-700">
                      {fmt.format(m.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        {vista === "detalle" && (
          <Card>
            <CardHeader
              title="Detalle"
              subtitle={`Mostrando ${rows.length} de ${totalCount} movimiento(s)${
                pageCount > 1 ? ` — página ${page} de ${pageCount}` : ""
              }. Seleccioná dos o más que correspondan al mismo hecho y unilos a mano.`}
            />
            <div className="px-6 py-5">
              <UnmatchedList transactions={rows} />
            </div>

            {pageCount > 1 && (
              <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-6 py-3.5 text-xs text-slate-500">
                <Link
                  href={pageHref(Math.max(1, page - 1))}
                  aria-disabled={page <= 1}
                  className={`rounded-lg px-3 py-1.5 font-medium ${
                    page <= 1 ? "pointer-events-none text-slate-300" : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  Anterior
                </Link>
                <span>
                  Página {page} de {pageCount}
                </span>
                <Link
                  href={pageHref(Math.min(pageCount, page + 1))}
                  aria-disabled={page >= pageCount}
                  className={`rounded-lg px-3 py-1.5 font-medium ${
                    page >= pageCount ? "pointer-events-none text-slate-300" : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  Siguiente
                </Link>
              </div>
            )}
          </Card>
        )}
      </main>
    </div>
  );
}
