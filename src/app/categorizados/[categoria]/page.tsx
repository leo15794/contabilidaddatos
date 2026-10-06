import Link from "next/link";
import { notFound } from "next/navigation";
import { NavBar } from "@/components/nav-bar";
import { getCategoryDetail } from "@/lib/queries";
import { Card, CardHeader, SourceBadge, Amount, StatCard, EmptyState } from "@/components/ui";
import { IconArrowLeft, IconInbox, IconFileText } from "@/components/icons";

export const dynamic = "force-dynamic";

const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });
const fmtDate = new Intl.DateTimeFormat("es-AR", { dateStyle: "short" });
const MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

function monthLabel(ym: string) {
  const [year, month] = ym.split("-");
  const idx = Number(month) - 1;
  return `${MESES[idx] ?? month} ${year}`;
}

export default async function CategoryDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ categoria: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { categoria } = await params;
  const category = decodeURIComponent(categoria);
  const { page: pageStr } = await searchParams;
  const page = Math.max(1, Number(pageStr) || 1);

  const detail = await getCategoryDetail(category, { page, pageSize: 50 });
  if (detail.totalCount === 0 && page === 1) notFound();

  return (
    <div className="flex min-h-screen flex-col">
      <NavBar />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <Link
          href="/dashboard"
          className="mb-4 inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-800"
        >
          <IconArrowLeft width={13} height={13} />
          Volver al Dashboard
        </Link>

        <div className="mb-6">
          <h1 className="text-xl font-semibold text-slate-900">{category}</h1>
          <p className="mt-1 text-sm text-slate-500">
            Todos los movimientos categorizados como &quot;{category}&quot;.
          </p>
        </div>

        <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
          <StatCard
            label="Movimientos"
            value={String(detail.totalCount)}
            tone="neutral"
            icon={<IconInbox width={17} height={17} />}
          />
          <StatCard
            label="Total"
            value={fmt.format(detail.totalAmount)}
            title={fmt.format(detail.totalAmount)}
            tone="neutral"
            icon={<IconFileText width={17} height={17} />}
          />
          <StatCard
            label="Meses con movimientos"
            value={String(detail.monthly.length)}
            tone="neutral"
            icon={<IconInbox width={17} height={17} />}
          />
        </div>

        <Card className="mb-6">
          <CardHeader title="Por mes" subtitle="Cuántos hubo y cuánto suman, mes a mes (el más reciente primero)." />
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

        <Card>
          <CardHeader
            title="Detalle"
            subtitle={`Mostrando ${detail.rows.length} de ${detail.totalCount} movimiento(s)${
              detail.pageCount > 1 ? ` — página ${detail.page} de ${detail.pageCount}` : ""
            }.`}
          />
          {detail.rows.length === 0 ? (
            <EmptyState icon={<IconInbox width={20} height={20} />} title="No hay movimientos en esta página" />
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Fecha</th>
                  <th className="px-5 py-2.5 font-medium">Fuente</th>
                  <th className="px-5 py-2.5 font-medium">Descripción</th>
                  <th className="px-5 py-2.5 font-medium">Monto</th>
                </tr>
              </thead>
              <tbody>
                {detail.rows.map((t) => (
                  <tr key={t.id} className="border-t border-slate-100 hover:bg-slate-50/80">
                    <td className="whitespace-nowrap px-5 py-3 text-slate-600">{fmtDate.format(t.date)}</td>
                    <td className="px-5 py-3">
                      <SourceBadge source={t.source} />
                    </td>
                    <td className="px-5 py-3 text-slate-700">{t.description}</td>
                    <td className="whitespace-nowrap px-5 py-3">
                      <Amount value={Number(t.amount)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {detail.pageCount > 1 && (
            <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-6 py-3.5 text-xs text-slate-500">
              <Link
                href={`/categorizados/${encodeURIComponent(category)}?page=${Math.max(1, page - 1)}`}
                aria-disabled={page <= 1}
                className={`rounded-lg px-3 py-1.5 font-medium ${
                  page <= 1 ? "pointer-events-none text-slate-300" : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                Anterior
              </Link>
              <span>
                Página {detail.page} de {detail.pageCount}
              </span>
              <Link
                href={`/categorizados/${encodeURIComponent(category)}?page=${Math.min(detail.pageCount, page + 1)}`}
                aria-disabled={page >= detail.pageCount}
                className={`rounded-lg px-3 py-1.5 font-medium ${
                  page >= detail.pageCount ? "pointer-events-none text-slate-300" : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                Siguiente
              </Link>
            </div>
          )}
        </Card>
      </main>
    </div>
  );
}
