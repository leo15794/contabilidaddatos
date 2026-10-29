import Link from "next/link";
import { NavBar } from "@/components/nav-bar";
import { getDashboardSummary, getCategorizedBreakdown, getUnmatchedBreakdown } from "@/lib/queries";
import { getAging, getCoverage, getMonthlyConciliation, getTopDebtors, type Aging, type Coverage } from "@/lib/inicio";
import { getSessionInfo } from "@/lib/auth/session";
import { ReconcileButton } from "./reconcile-button";

export const dynamic = "force-dynamic";

const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });
// Montos grandes sin centavos: de un vistazo no aportan y alargan el número (el exacto queda en el title).
const fmtCompact = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });
const fmtMillones = (n: number) => `$ ${(n / 1_000_000).toLocaleString("es-AR", { maximumFractionDigits: 1 })} M`;
const MESES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const MESES_LARGOS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

type Periodo = "mes" | "6m" | "anio" | "todo";

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Rango de cada chip de período, en el formato de ?from=&to= que ya entendía el tablero. */
function periodRange(p: Periodo): { from?: string; to?: string } {
  const now = new Date();
  if (p === "mes") return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)) };
  if (p === "6m") return { from: iso(new Date(now.getFullYear(), now.getMonth() - 5, 1)) };
  if (p === "anio") return { from: `${now.getFullYear()}-01-01` };
  return {};
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { from: fromStr, to: toStr } = await searchParams;
  const me = await getSessionInfo();
  const readOnly = me?.role !== "admin";

  // Fechas en "yyyy-mm-dd" (hora local); "to" llega hasta el final del día. Si
  // vienen al revés se reordenan en vez de mostrar siempre cero.
  let from = fromStr ? new Date(`${fromStr}T00:00:00`) : undefined;
  let to = toStr ? new Date(`${toStr}T23:59:59.999`) : undefined;
  if (from && to && from > to) [from, to] = [new Date(`${toStr}T00:00:00`), new Date(`${fromStr}T23:59:59.999`)];

  const [summary, categorized, unmatched, receivable, payable, debtors, monthly, coverage] = await Promise.all([
    getDashboardSummary({ from, to }),
    getCategorizedBreakdown({ from, to }),
    getUnmatchedBreakdown(),
    getAging("afip_issued"),
    getAging("afip_received"),
    getTopDebtors(5),
    getMonthlyConciliation(6, 1),
    getCoverage(6),
  ]);
  const unmatchedCount = unmatched.reduce((acc, r) => acc + r.count, 0);

  const activePeriod = (["mes", "6m", "anio", "todo"] as Periodo[]).find((p) => {
    const r = periodRange(p);
    return (r.from ?? "") === (fromStr ?? "") && (r.to ?? "") === (toStr ?? "");
  });
  const periodHref = (p: Periodo) => {
    const r = periodRange(p);
    const q = new URLSearchParams();
    if (r.from) q.set("from", r.from);
    if (r.to) q.set("to", r.to);
    const s = q.toString();
    return s ? `/dashboard?${s}` : "/dashboard";
  };

  const tasks = buildTasks({ pending: summary.pendingReviewCount, unmatched: unmatchedCount, coverage, debtors, readOnly });
  const hoy = new Date();
  const saludo = hoy.getHours() < 13 ? "Buen día" : hoy.getHours() < 20 ? "Buenas tardes" : "Buenas noches";
  const nombre = me && me.userId > 0 ? me.name.split(" ")[0] : "";

  return (
    <div className="flex min-h-screen flex-col">
      <NavBar />
      <main className="mx-auto w-full max-w-[1180px] flex-1 px-5 py-7 lg:px-9">
        {/* Encabezado */}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[12.5px] font-medium text-slate-400">{fechaLarga(hoy)}</p>
            <h1 className="mt-1 text-[26px] font-bold tracking-tight text-slate-900">
              {saludo}
              {nombre ? `, ${nombre}` : ""}
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg bg-white p-1 text-[12.5px] font-medium ring-1 ring-slate-200">
              {([
                ["mes", "Este mes"],
                ["6m", "Últimos 6 meses"],
                ["anio", String(hoy.getFullYear())],
                ["todo", "Todo"],
              ] as [Periodo, string][]).map(([p, label]) => (
                <Link
                  key={p}
                  href={periodHref(p)}
                  className={`rounded-md px-3 py-1.5 ${activePeriod === p ? "bg-slate-900 text-white" : "text-slate-500 hover:text-slate-900"}`}
                >
                  {label}
                </Link>
              ))}
            </div>
            {!readOnly && <ReconcileButton />}
            {!readOnly && (
              <Link href="/import" className="rounded-lg bg-indigo-600 px-3.5 py-2 text-[12.5px] font-semibold text-white shadow-sm hover:bg-indigo-700">
                + Importar
              </Link>
            )}
          </div>
        </div>
        {!activePeriod && (
          <p className="mt-2 text-xs text-slate-500">
            Período: {from ? `desde ${from.toLocaleDateString("es-AR")}` : ""} {to ? `hasta ${to.toLocaleDateString("es-AR")}` : ""}
          </p>
        )}

        {/* Números principales */}
        <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl bg-slate-900 p-5 text-white">
            <p className="text-[12.5px] font-medium text-slate-300">Conciliado</p>
            <div className="mt-2 flex items-center gap-4">
              <Ring pct={summary.conciliadoPct} />
              <p className="text-[34px] font-extrabold leading-none tabular-nums">{summary.conciliadoPct}%</p>
            </div>
            <p className="mt-3 text-[11.5px] text-slate-400">
              {summary.resolvedCount.toLocaleString("es-AR")} de {summary.pctDenominator.toLocaleString("es-AR")} movimientos
              resueltos en el período
            </p>
          </div>
          <AgingCard title="Te deben (clientes)" aging={receivable} href="/cuenta-corriente" extra="facturas emitidas sin cobro" />
          <AgingCard title="Debés (proveedores)" aging={payable} href="/cuenta-corriente" extra="facturas recibidas sin pago cruzado" />
          <div className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
            <p className="text-[12.5px] font-medium text-slate-500">Para revisar</p>
            <p className="mt-2 text-[26px] font-extrabold tracking-tight tabular-nums text-amber-600">
              {summary.pendingReviewCount} {summary.pendingReviewCount === 1 ? "sugerencia" : "sugerencias"}
            </p>
            <p className="mt-1 text-[12px] text-slate-500">y {unmatchedCount.toLocaleString("es-AR")} movimientos sin pareja</p>
            {!readOnly && (
              <Link
                href="/review"
                className="mt-3 block rounded-lg bg-amber-50 py-1.5 text-center text-[12.5px] font-semibold text-amber-700 ring-1 ring-amber-200 hover:bg-amber-100"
              >
                Revisar ahora →
              </Link>
            )}
          </div>
        </div>

        {/* Gráfico + tareas */}
        <div className="mt-5 grid gap-4 xl:grid-cols-3">
          <div className="rounded-2xl bg-white p-5 ring-1 ring-slate-200 xl:col-span-2">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-[14px] font-semibold text-slate-900">% conciliado por mes</p>
                <p className="text-[12px] text-slate-400">Si un mes baja de golpe, casi siempre falta cargar algún archivo de ese mes</p>
              </div>
            </div>
            <div className="mt-5 flex h-[190px] items-end gap-3 border-b border-slate-100 px-1 sm:gap-5">
              {monthly.map((m) => {
                const low = m.pct !== null && m.pct < 75;
                return (
                  <div key={m.month} className="flex flex-1 flex-col items-center gap-2">
                    <span className={`text-[11.5px] font-semibold tabular-nums ${low ? "text-amber-600" : "text-slate-600"}`}>
                      {m.pct === null ? "—" : `${m.pct}%`}
                    </span>
                    <div className="flex h-[150px] w-full flex-col justify-end overflow-hidden rounded-lg bg-slate-100">
                      <div
                        className={`rounded-lg ${low ? "bg-amber-400" : "bg-indigo-500"}`}
                        style={{ height: `${m.pct ?? 0}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-2 flex gap-3 px-1 text-center text-[11.5px] text-slate-400 sm:gap-5">
              {monthly.map((m) => (
                <span key={m.month} className="flex-1">
                  {MESES[Number(m.month.slice(5, 7)) - 1]}
                </span>
              ))}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
            <p className="text-[14px] font-semibold text-slate-900">Qué hacer ahora</p>
            <p className="text-[12px] text-slate-400">Lo que más suma primero</p>
            {tasks.length === 0 ? (
              <p className="mt-4 text-[12.5px] text-slate-500">Todo al día. 🎉</p>
            ) : (
              <ul className="mt-4 space-y-3 text-[12.5px]">
                {tasks.map((t) => (
                  <li key={t.title}>
                    <Link href={t.href} className="flex gap-3 rounded-lg p-1 -m-1 hover:bg-slate-50">
                      <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[12px] font-bold ${TASK_TONES[t.tone]}`}>
                        {t.icon}
                      </span>
                      <span>
                        <span className="block font-semibold text-slate-800">{t.title}</span>
                        <span className="block text-slate-500">{t.detail}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Deudores + cobertura */}
        <div className="mt-5 grid gap-4 xl:grid-cols-3">
          <div className="overflow-hidden rounded-2xl bg-white ring-1 ring-slate-200 xl:col-span-2">
            <div className="flex items-center justify-between px-5 pt-5">
              <p className="text-[14px] font-semibold text-slate-900">Clientes que más deben</p>
              <Link href="/cuenta-corriente" className="text-[12px] font-semibold text-indigo-600 hover:text-indigo-700">
                Ver cuenta corriente →
              </Link>
            </div>
            {debtors.length === 0 ? (
              <p className="px-5 py-6 text-[12.5px] text-slate-500">Ningún cliente tiene facturas sin cobrar.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="mt-3 w-full min-w-[560px] text-[12.5px]">
                  <thead className="text-left text-[11px] uppercase tracking-wider text-slate-400">
                    <tr>
                      <th className="px-5 py-2 font-medium">Cliente</th>
                      <th className="px-3 py-2 text-right font-medium">0–30</th>
                      <th className="px-3 py-2 text-right font-medium">31–90</th>
                      <th className="px-3 py-2 text-right font-medium">+90 días</th>
                      <th className="px-5 py-2 text-right font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody className="tabular-nums">
                    {debtors.map((d) => (
                      <tr key={d.cuit} className="border-t border-slate-100 hover:bg-slate-50/80">
                        <td className="px-5 py-2.5">
                          <Link href={`/cuenta-corriente/clientes/${d.cuit}?vista=abiertas`} className="font-medium text-slate-800 hover:text-indigo-600">
                            {d.name}
                          </Link>
                          <span className="ml-1.5 text-[11px] text-slate-400">{d.count} fact.</span>
                        </td>
                        <AgingCell value={d.d0_30} />
                        <AgingCell value={d.d31_90} />
                        <AgingCell value={d.d90} danger />
                        <td className="px-5 text-right font-semibold" title={fmt.format(d.total)}>
                          {fmtCompact.format(d.total)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
            <p className="text-[14px] font-semibold text-slate-900">Datos cargados</p>
            <p className="text-[12px] text-slate-400">Un mes en gris es un archivo que falta subir</p>
            <div className="mt-4 space-y-2.5 text-[12px]">
              {(
                [
                  ["bank", "Banco"],
                  ["card", "Tarjeta"],
                  ["afip", "AFIP"],
                  ["retention", "Retenciones"],
                ] as [keyof Omit<Coverage, "month">, string][]
              ).map(([key, label]) => (
                <div key={key} className="flex items-center gap-3">
                  <span className="w-20 text-slate-600">{label}</span>
                  <div className="flex flex-1 gap-0.5">
                    {coverage.map((c) => (
                      <i
                        key={c.month}
                        title={`${label} · ${MESES[Number(c.month.slice(5, 7)) - 1]}: ${c[key]} movimientos`}
                        className={`h-4 flex-1 rounded-sm ${c[key] > 0 ? "bg-indigo-500" : "bg-slate-200"}`}
                      />
                    ))}
                  </div>
                </div>
              ))}
              <div className="flex gap-0.5 pl-[92px] text-center text-[10.5px] text-slate-400">
                {coverage.map((c) => (
                  <span key={c.month} className="flex-1">
                    {MESES[Number(c.month.slice(5, 7)) - 1]}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Categorizados: la puerta de entrada al detalle de cada categoría */}
        {categorized.length > 0 && (
          <div className="mt-5 rounded-2xl bg-white ring-1 ring-slate-200">
            <div className="px-5 pt-5">
              <p className="text-[14px] font-semibold text-slate-900">Movimientos categorizados</p>
              <p className="text-[12px] text-slate-400">Impuestos, comisiones, retiros y movimientos internos que no necesitan conciliar</p>
            </div>
            <div className="grid gap-x-6 px-5 py-3 sm:grid-cols-2">
              {categorized.map((row) => (
                <Link
                  key={row.category}
                  href={`/categorizados/${encodeURIComponent(row.category)}`}
                  className="flex items-center justify-between border-b border-slate-100 py-2 text-[12.5px] last:border-b-0 hover:text-indigo-600"
                >
                  <span className="truncate text-slate-700">
                    {row.category} <span className="text-slate-400">· {row.count}</span>
                  </span>
                  <span className="shrink-0 font-medium tabular-nums text-slate-700">{fmtCompact.format(row.total)}</span>
                </Link>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function fechaLarga(d: Date) {
  const s = d.toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function Ring({ pct }: { pct: number }) {
  return (
    <svg width="64" height="64" viewBox="0 0 36 36" aria-hidden>
      <circle cx="18" cy="18" r="15.9" fill="none" stroke="#334155" strokeWidth="3.2" />
      <circle
        cx="18"
        cy="18"
        r="15.9"
        fill="none"
        stroke="#818cf8"
        strokeWidth="3.2"
        strokeDasharray={`${Math.max(0, Math.min(100, pct))} 100`}
        strokeLinecap="round"
        transform="rotate(-90 18 18)"
        pathLength={100}
      />
    </svg>
  );
}

function AgingCard({ title, aging, href, extra }: { title: string; aging: Aging; href: string; extra: string }) {
  const pct = (n: number) => (aging.total > 0 ? `${(n / aging.total) * 100}%` : "0%");
  return (
    <Link href={href} className="block rounded-2xl bg-white p-5 ring-1 ring-slate-200 transition-shadow hover:shadow-md">
      <p className="text-[12.5px] font-medium text-slate-500">{title}</p>
      <p className="mt-2 text-[26px] font-extrabold tracking-tight tabular-nums text-slate-900" title={fmt.format(aging.total)}>
        {fmtCompact.format(aging.total)}
      </p>
      <p className={`mt-1 text-[12px] ${aging.d90 > 0 ? "text-rose-600" : "text-slate-500"}`}>
        {aging.d90 > 0 ? `${fmtMillones(aging.d90)} con más de 90 días` : `${aging.count} ${extra}`}
      </p>
      <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-slate-100">
        <div className="bg-emerald-400" style={{ width: pct(aging.d0_30) }} />
        <div className="bg-amber-400" style={{ width: pct(aging.d31_90) }} />
        <div className="bg-rose-400" style={{ width: pct(aging.d90) }} />
      </div>
    </Link>
  );
}

function AgingCell({ value, danger = false }: { value: number; danger?: boolean }) {
  if (value <= 0) return <td className="px-3 text-right text-slate-300">—</td>;
  return (
    <td className={`px-3 text-right ${danger ? "text-rose-600" : "text-slate-700"}`} title={fmt.format(value)}>
      {fmtCompact.format(value)}
    </td>
  );
}

type Task = { title: string; detail: string; href: string; icon: string; tone: "up" | "warn" | "money" | "neutral" };
const TASK_TONES: Record<Task["tone"], string> = {
  up: "bg-indigo-50 text-indigo-600",
  warn: "bg-amber-50 text-amber-600",
  money: "bg-rose-50 text-rose-600",
  neutral: "bg-slate-100 text-slate-500",
};

/** Las tareas salen de los datos: archivos que faltan, sugerencias sin revisar y deudas viejas. */
function buildTasks({
  pending,
  unmatched,
  coverage,
  debtors,
  readOnly,
}: {
  pending: number;
  unmatched: number;
  coverage: Coverage[];
  debtors: { name: string; cuit: string; d31_90: number; d90: number }[];
  readOnly: boolean;
}): Task[] {
  const tasks: Task[] = [];

  // El último mes cerrado: si a alguna fuente le falta, es lo primero que hay que cargar.
  const lastClosed = coverage[coverage.length - 2];
  if (lastClosed && !readOnly) {
    const missing = [
      lastClosed.bank === 0 && "banco",
      lastClosed.card === 0 && "tarjeta",
      lastClosed.afip === 0 && "AFIP",
    ].filter(Boolean) as string[];
    if (missing.length > 0) {
      const m = MESES_LARGOS[Number(lastClosed.month.slice(5, 7)) - 1];
      tasks.push({ title: `Cargar ${missing.join(", ")} de ${m}`, detail: "El mes ya cerró y no hay movimientos", href: "/import", icon: "↑", tone: "up" });
    }
  }
  if (pending > 0 && !readOnly) {
    tasks.push({
      title: `Revisar ${pending} ${pending === 1 ? "sugerencia" : "sugerencias"}`,
      detail: "Cruces probables esperando tu OK",
      href: "/review",
      icon: "!",
      tone: "warn",
    });
  }
  for (const d of debtors.filter((x) => x.d90 + x.d31_90 > 0).slice(0, 2)) {
    tasks.push({
      title: `Reclamar a ${d.name}`,
      detail: `${fmtMillones(d.d90 + d.d31_90)} vencidos hace más de 30 días`,
      href: `/cuenta-corriente/clientes/${d.cuit}?vista=abiertas`,
      icon: "$",
      tone: "money",
    });
  }
  if (unmatched > 0 && !readOnly) {
    tasks.push({
      title: `${unmatched.toLocaleString("es-AR")} movimientos sin pareja`,
      detail: "Falta su factura o su pago",
      href: "/review#sin-conciliar",
      icon: "?",
      tone: "neutral",
    });
  }
  return tasks.slice(0, 5);
}
