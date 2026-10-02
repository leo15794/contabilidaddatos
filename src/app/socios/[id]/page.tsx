import Link from "next/link";
import { notFound } from "next/navigation";
import { NavBar } from "@/components/nav-bar";
import {
  addMonths,
  dateToMonthKey,
  getPartner,
  getPartnerBalance,
  getPartnerMonthlyHistory,
  getPartnerSpend,
  getPartnerTransactions,
  monthKeyToDate,
  startOfMonth,
} from "@/lib/partners";
import { Card, CardHeader, Amount, EmptyState } from "@/components/ui";
import { IconArrowLeft, IconInbox, IconArrowDownRight, IconWallet, IconCheckCircle } from "@/components/icons";
import { BalanceForm } from "../balance-form";
import { PartnerSpendChart } from "../partner-spend-chart";
import { EditPartnerForm } from "../edit-partner-form";

export const dynamic = "force-dynamic";

const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });
const fmtDate = new Intl.DateTimeFormat("es-AR", { dateStyle: "short" });
const fmtMonth = (d: Date) => new Intl.DateTimeFormat("es-AR", { month: "long", year: "numeric" }).format(d);

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

export default async function PartnerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ month?: string }>;
}) {
  const { id } = await params;
  const { month: monthParam } = await searchParams;
  const partnerId = Number(id);

  const partner = await getPartner(partnerId);
  if (!partner) notFound();

  const selectedMonth = monthParam ? monthKeyToDate(monthParam) : startOfMonth(new Date());
  const monthKey = dateToMonthKey(selectedMonth);
  const monthEnd = addMonths(selectedMonth, 1);
  const prevMonthKey = dateToMonthKey(addMonths(selectedMonth, -1));
  const nextMonthKey = dateToMonthKey(addMonths(selectedMonth, 1));

  const [{ total: spent }, balance, txns, history] = await Promise.all([
    getPartnerSpend(partner, selectedMonth, monthEnd),
    getPartnerBalance(partner.id, selectedMonth),
    getPartnerTransactions(partner, selectedMonth, monthEnd),
    getPartnerMonthlyHistory(partner, 6),
  ]);

  const balanceAmount = balance ? Number(balance.amount) : null;
  const remaining = balanceAmount === null ? null : balanceAmount - spent;
  const over = remaining !== null && remaining < 0;
  const pct = balanceAmount && balanceAmount > 0 ? Math.min(100, Math.round((spent / balanceAmount) * 100)) : 0;

  return (
    <div className="flex min-h-screen flex-col">
      <NavBar />

      <div className="bg-gradient-to-br from-indigo-50 via-violet-50/70 to-slate-50 px-4 pb-8 pt-10">
        <div className="mx-auto w-full max-w-5xl">
          <Link
            href="/socios"
            className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800"
          >
            <IconArrowLeft width={14} height={14} />
            Socios
          </Link>

          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3.5">
              <div className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-600 to-violet-500 text-lg font-bold text-white">
                {initials(partner.name)}
              </div>
              <div>
                <h1 className="text-[28px] font-extrabold tracking-tight text-slate-900">{partner.name}</h1>
                {partner.aliasName && (
                  <p className="mt-0.5 text-xs text-slate-500">
                    También matchea como{" "}
                    <span className="font-semibold text-slate-600">&quot;{partner.aliasName}&quot;</span>
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-white/80 p-1 text-sm">
              <Link
                href={`/socios/${partner.id}?month=${prevMonthKey}`}
                className="rounded-lg px-2.5 py-1.5 text-slate-500 hover:bg-slate-100"
              >
                ← Anterior
              </Link>
              <span className="min-w-32 text-center text-[13px] font-semibold capitalize text-slate-700">
                {fmtMonth(selectedMonth)}
              </span>
              <Link
                href={`/socios/${partner.id}?month=${nextMonthKey}`}
                className="rounded-lg px-2.5 py-1.5 text-slate-500 hover:bg-slate-100"
              >
                Siguiente →
              </Link>
            </div>
          </div>
        </div>
      </div>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <div className="mb-7 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-[20px] bg-gradient-to-br from-slate-900 to-slate-800 px-5 py-4 shadow-[0_14px_32px_-16px_rgba(15,23,42,.45)]">
            <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 text-violet-300">
              <IconArrowDownRight width={17} height={17} />
            </div>
            <p className="text-xs text-slate-400">Gastado este mes</p>
            <p className="mt-0.5 text-xl font-bold tabular-nums text-white">{fmt.format(spent)}</p>
          </div>
          <Card className="px-5 py-4">
            <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
              <IconWallet width={17} height={17} />
            </div>
            <p className="text-xs text-slate-500">Saldo asignado</p>
            <p className="mt-0.5 text-xl font-bold tabular-nums text-slate-900">
              {balanceAmount === null ? (
                <span className="text-base font-semibold text-slate-400">Sin asignar</span>
              ) : (
                fmt.format(balanceAmount)
              )}
            </p>
            {balanceAmount !== null && (
              <div className="mt-2.5 h-[7px] w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className={`h-full rounded-full ${over ? "bg-rose-600" : "bg-indigo-600"}`}
                  style={{ width: `${over ? 100 : pct}%` }}
                />
              </div>
            )}
          </Card>
          <Card className="px-5 py-4">
            <div
              className={`mb-2 flex h-8 w-8 items-center justify-center rounded-lg ${over ? "bg-rose-50 text-rose-600" : "bg-emerald-50 text-emerald-600"}`}
            >
              <IconCheckCircle width={17} height={17} />
            </div>
            <p className="text-xs text-slate-500">Restante</p>
            <p className="mt-0.5 text-xl font-bold tabular-nums">
              {remaining === null ? (
                <span className="text-base font-semibold text-slate-400">—</span>
              ) : (
                <Amount value={remaining} className="text-xl" />
              )}
            </p>
          </Card>
        </div>

        <Card className="mb-6">
          <CardHeader
            title="Datos del socio"
            subtitle="Si el banco imprime su nombre distinto (typos, inicial del medio), cargalo acá como alias para que sus gastos se sumen igual."
          />
          <div className="px-6 py-5">
            <EditPartnerForm partner={partner} />
          </div>
        </Card>

        <Card className="mb-6">
          <CardHeader title="Asignar saldo" subtitle={`Para ${fmtMonth(selectedMonth)}`} />
          <div className="px-6 py-5">
            <BalanceForm partnerId={partner.id} month={monthKey} currentAmount={balanceAmount} />
          </div>
        </Card>

        <Card className="mb-6">
          <CardHeader title="Evolución mensual" subtitle="Últimos 6 meses, gasto de tarjeta" />
          <PartnerSpendChart data={history} />
        </Card>

        <Card>
          <CardHeader title="Movimientos de este mes" />
          {txns.length === 0 ? (
            <EmptyState
              icon={<IconInbox width={20} height={20} />}
              title="Sin movimientos en este mes"
              description="No se encontró ningún consumo de tarjeta con este titular en el período seleccionado."
            />
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Fecha</th>
                  <th className="px-5 py-2.5 font-medium">Descripción</th>
                  <th className="px-5 py-2.5 font-medium">Importe</th>
                </tr>
              </thead>
              <tbody>
                {txns.map((t) => (
                  <tr key={t.id} className="border-t border-slate-100 hover:bg-slate-50/80">
                    <td className="whitespace-nowrap px-5 py-3 text-slate-500">{fmtDate.format(t.date)}</td>
                    <td className="px-5 py-3 text-slate-700">{t.description}</td>
                    <td className="whitespace-nowrap px-5 py-3">
                      <Amount value={Number(t.amount)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </main>
    </div>
  );
}
