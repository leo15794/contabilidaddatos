import Link from "next/link";
import { NavBar } from "@/components/nav-bar";
import { getMercadoLibrePurchases, type MlPackStatus } from "@/lib/mercadolibre";
import { EmptyState } from "@/components/ui";
import { IconShoppingBag } from "@/components/icons";

export const dynamic = "force-dynamic";

const STATUS: Record<MlPackStatus, { label: string; className: string; help: string }> = {
  conciliada: { label: "Conciliada", className: "bg-emerald-50 text-emerald-700 ring-emerald-200", help: "Factura y pago ya cruzados." },
  otro_pago: {
    label: "Cruzada con otro pago",
    className: "bg-violet-50 text-violet-700 ring-violet-200",
    help: "La factura quedó cruzada con un pago que no es el cargo de esta compra: revisar ese cruce.",
  },
  sugerida: { label: "Para revisar", className: "bg-amber-50 text-amber-700 ring-amber-200", help: "Hay factura y cargo: confirmalos en Revisar sugerencias." },
  sin_factura: {
    label: "Sin factura",
    className: "bg-rose-50 text-rose-700 ring-rose-200",
    help: "Se pagó con tarjeta pero no hay factura del vendedor en AFIP: reclamarla.",
  },
  sin_cargo: {
    label: "Sin cargo",
    className: "bg-sky-50 text-sky-700 ring-sky-200",
    help: "Está la factura pero no el cargo: falta el resumen de esa tarjeta o se pagó con otro medio.",
  },
  sin_datos: { label: "Sin factura ni cargo", className: "bg-slate-100 text-slate-600 ring-slate-200", help: "No aparece ni la factura ni el cargo." },
};

type Filter = "todas" | MlPackStatus;

const FILTERS: { key: Filter; label: string }[] = [
  { key: "todas", label: "Todas" },
  { key: "sin_factura", label: "Sin factura" },
  { key: "sin_cargo", label: "Sin cargo" },
  { key: "otro_pago", label: "Cruzadas con otro pago" },
  { key: "sugerida", label: "Para revisar" },
  { key: "conciliada", label: "Conciliadas" },
  { key: "sin_datos", label: "Sin factura ni cargo" },
];

const money = (n: number) => `$ ${n.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d: Date) => d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });

export default async function MercadoLibrePage({ searchParams }: { searchParams: Promise<{ estado?: string }> }) {
  const { estado } = await searchParams;
  const filter: Filter = FILTERS.find((f) => f.key === estado)?.key ?? "todas";
  const purchases = await getMercadoLibrePurchases();

  const counts = new Map<MlPackStatus, { n: number; amount: number }>();
  for (const p of purchases) {
    for (const pack of p.packs) {
      const c = counts.get(pack.status) ?? { n: 0, amount: 0 };
      c.n++;
      c.amount += pack.total;
      counts.set(pack.status, c);
    }
  }
  const visible = purchases
    .map((p) => ({ ...p, packs: filter === "todas" ? p.packs : p.packs.filter((k) => k.status === filter) }))
    .filter((p) => p.packs.length > 0);

  return (
    <div className="flex min-h-screen flex-col">
      <NavBar />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-slate-900">Compras de MercadoLibre</h1>
          <p className="text-sm text-slate-500">
            Cada compra del reporte con la factura del vendedor y el cargo de tarjeta que le corresponden. Una fila por vendedor.
          </p>
        </div>

        {purchases.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white">
            <EmptyState
              icon={<IconShoppingBag width={20} height={20} />}
              title="Todavía no hay compras cargadas"
              description="Subí los reportes de compras de MercadoLibre desde Importar."
            />
          </div>
        ) : (
          <>
            <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {(["sin_factura", "sin_cargo", "otro_pago", "sugerida", "conciliada"] as const).map((s) => (
                <Link
                  key={s}
                  href={`/mercadolibre?estado=${s}`}
                  className="rounded-xl border border-slate-200 bg-white p-4 transition-colors hover:border-indigo-300"
                >
                  <div className="flex items-center justify-between">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${STATUS[s].className}`}>{STATUS[s].label}</span>
                    <span className="text-lg font-semibold text-slate-900">{counts.get(s)?.n ?? 0}</span>
                  </div>
                  <p className="mt-2 text-xs text-slate-500">{money(counts.get(s)?.amount ?? 0)}</p>
                  <p className="mt-1 text-[11px] leading-snug text-slate-400">{STATUS[s].help}</p>
                </Link>
              ))}
            </div>

            <div className="mb-4 flex flex-wrap gap-1.5">
              {FILTERS.map((f) => (
                <Link
                  key={f.key}
                  href={f.key === "todas" ? "/mercadolibre" : `/mercadolibre?estado=${f.key}`}
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    filter === f.key ? "bg-slate-900 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
                  }`}
                >
                  {f.label}
                </Link>
              ))}
            </div>

            <div className="space-y-3">
              {visible.map((p) => (
                <div key={p.purchaseId} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                  <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 bg-slate-50/60 px-4 py-2.5">
                    <div className="text-xs text-slate-500">
                      <span className="font-medium text-slate-700">{fmtDate(p.date)}</span> · Compra N° {p.purchaseId}
                    </div>
                    <div className="text-xs font-medium text-slate-700">{money(p.total)}</div>
                  </div>
                  <ul className="divide-y divide-slate-100">
                    {p.packs.map((k) => (
                      <li key={k.key} className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${STATUS[k.status].className}`}>
                            {STATUS[k.status].label}
                          </span>
                          <span className="text-sm font-medium text-slate-900">{money(k.total)}</span>
                        </div>
                        <p className="mt-1 break-words text-sm text-slate-700">{k.products.join(" + ")}</p>
                        <div className="mt-1.5 grid gap-0.5 text-xs text-slate-500">
                          <span>
                            Factura:{" "}
                            {k.invoice ? (
                              <span className="text-slate-700">
                                {k.invoice.name} · {money(k.invoice.amount)} · {fmtDate(k.invoice.date)}
                              </span>
                            ) : (
                              <span className="text-rose-600">no encontrada</span>
                            )}
                          </span>
                          <span>
                            Tarjeta:{" "}
                            {k.charge ? (
                              <span className="text-slate-700">
                                {k.charge.description} · {money(k.charge.amount)}
                                {k.charge.count > 1 ? ` en ${k.charge.count} cuotas` : ""} · {fmtDate(k.charge.date)}
                              </span>
                            ) : (
                              <span className="text-sky-700">no encontrado</span>
                            )}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
