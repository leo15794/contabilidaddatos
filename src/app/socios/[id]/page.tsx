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
import { IconArrowLeft, IconInbox } from "@/components/icons";
import { BalanceForm } from "../balance-form";
import { PartnerSpendChart } from "../partner-spend-chart";

export const dynamic = "force-dynamic";

const fmtDate = new Intl.DateTimeFormat("es-AR", { dateStyle: "short" });
const fmtMonth = (d: Date) => new Intl.DateTimeFormat("es-AR", { month: "long", year: "numeric" }).format(d);

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
    getPartnerSpend(partner.name, selectedMonth, monthEnd),
    getPartnerBalance(partner.id, selectedMonth),
    getPartnerTransactions(partner.name, selectedMonth, monthEnd),
    getPartnerMonthlyHistory(partner.name, 6),
  ]);

  const balanceAmount = balance ? Number(balance.amount) : null;
  const remaining = balanceAmount === null ? null : balanceAmount - spent;

  return (
    <div className="flex min-h-screen flex-col">
      <NavBar />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <Link href="/socios" className="mb-4 flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
          <IconArrowLeft width={14} height={14} />
          Socios
        </Link>

        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-xl font-semibold text-slate-900">{partner.name}</h1>
          <div className="flex items-center gap-2 text-sm">
            <Link
              href={`/socios/${partner.id}?month=${prevMonthKey}`}
              className="rounded-lg px-2.5 py-1.5 text-slate-500 hover:bg-slate-100"
            >
              ← Mes anterior
            </Link>
            <span className="min-w-36 text-center font-medium capitalize text-slate-700">
              {fmtMonth(selectedMonth)}
            </span>
            <Link
              href={`/socios/${partner.id}?month=${nextMonthKey}`}
              className="rounded-lg px-2.5 py-1.5 text-slate-500 hover:bg-slate-100"
            >
              Mes siguiente →
            </Link>
          </div>
        </div>

        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Card className="px-4 py-3.5">
            <p className="text-xs text-slate-500">Gastado este mes</p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums text-rose-600">
              <Amount value={-spent} />
            </p>
          </Card>
          <Card className="px-4 py-3.5">
            <p className="text-xs text-slate-500">Saldo asignado</p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums text-slate-700">
              {balanceAmount === null ? "Sin asignar" : new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(balanceAmount)}
            </p>
          </Card>
          <Card className="px-4 py-3.5">
            <p className="text-xs text-slate-500">Restante</p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums">
              {remaining === null ? <span className="text-slate-400">—</span> : <Amount value={remaining} />}
            </p>
          </Card>
        </div>

        <Card className="mb-6">
          <CardHeader title="Asignar saldo" subtitle={`Para ${fmtMonth(selectedMonth)}`} />
          <div className="px-5 py-4">
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
