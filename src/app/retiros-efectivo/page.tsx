import Link from "next/link";
import { NavBar } from "@/components/nav-bar";
import { getCashWithdrawals, getWithdrawalPayments } from "@/lib/queries";
import { Card, StatCard } from "@/components/ui";
import { IconWallet, IconCheckCircle, IconAlertTriangle } from "@/components/icons";

export const dynamic = "force-dynamic";

const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });
const fmtDate = new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeZone: "UTC" });

/**
 * Retiros de efectivo de la empresa (cajero, caja de ahorro) y las facturas
 * que se pagaron en mano con esa plata ("Pagada en efectivo" en Conciliar a
 * mano). Lo que queda sin justificar es efectivo que salió del banco sin
 * comprobante todavía.
 */
export default async function RetirosEfectivoPage({ searchParams }: { searchParams: Promise<{ ver?: string }> }) {
  const { ver } = await searchParams;
  const [withdrawals, payments] = await Promise.all([getCashWithdrawals(), getWithdrawalPayments()]);
  const pendingOnly = ver !== "todos";
  const shown = pendingOnly ? withdrawals.filter((w) => w.available > 0.01) : withdrawals;

  const total = withdrawals.reduce((acc, w) => acc + w.amount, 0);
  const used = withdrawals.reduce((acc, w) => acc + w.used, 0);
  const byWithdrawal = new Map<number, typeof payments>();
  for (const p of payments) byWithdrawal.set(p.retiroId, [...(byWithdrawal.get(p.retiroId) ?? []), p]);

  const tab = (active: boolean) =>
    `rounded-full px-3 py-1.5 text-[12.5px] font-medium ${
      active ? "bg-slate-900 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
    }`;

  return (
    <div className="flex min-h-screen flex-col">
      <NavBar />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-slate-900">Retiros de efectivo</h1>
          <p className="text-sm text-slate-500">
            La plata que la empresa sacó del banco en efectivo y qué facturas se pagaron con ella. Para justificar un retiro,
            en Sin conciliar tildá la factura y usá «Pagada en efectivo» → «De un retiro de la empresa».
          </p>
        </div>

        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <StatCard label="Retirado" value={fmt.format(total)} tone="neutral" icon={<IconWallet width={17} height={17} />} />
          <StatCard
            label="Justificado con facturas"
            value={fmt.format(used)}
            tone="neutral"
            icon={<IconCheckCircle width={17} height={17} />}
          />
          <StatCard
            label="Sin justificar"
            value={fmt.format(total - used)}
            tone="neutral"
            icon={<IconAlertTriangle width={17} height={17} />}
          />
        </div>

        <div className="mb-4 flex gap-2">
          <Link href="/retiros-efectivo" className={tab(pendingOnly)}>
            Con saldo · {withdrawals.filter((w) => w.available > 0.01).length}
          </Link>
          <Link href="/retiros-efectivo?ver=todos" className={tab(!pendingOnly)}>
            Todos · {withdrawals.length}
          </Link>
        </div>

        <Card>
          {shown.length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-slate-500">No hay retiros con saldo sin justificar.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Fecha</th>
                  <th className="px-5 py-2.5 font-medium">Retiro</th>
                  <th className="px-5 py-2.5 text-right font-medium">Importe</th>
                  <th className="px-5 py-2.5 text-right font-medium">Justificado</th>
                  <th className="px-5 py-2.5 text-right font-medium">Saldo</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((w) => {
                  const list = byWithdrawal.get(w.id) ?? [];
                  return (
                    <tr key={w.id} className="border-t border-slate-100 align-top">
                      <td className="whitespace-nowrap px-5 py-3 text-slate-600">{fmtDate.format(new Date(w.date))}</td>
                      <td className="px-5 py-3 text-slate-700">
                        {w.description}
                        {list.length > 0 && (
                          <details className="mt-1 text-xs text-slate-500">
                            <summary className="cursor-pointer text-indigo-600">
                              {list.length} pago{list.length === 1 ? "" : "s"} con facturas
                            </summary>
                            <ul className="mt-1.5 space-y-1.5">
                              {list.map((p) => (
                                <li key={p.cashId}>
                                  <span className="font-medium text-slate-700">
                                    {fmtDate.format(p.date)} · {fmt.format(p.amount)}
                                  </span>
                                  {p.quien && p.quien !== "la empresa" && <span> · la llevó {p.quien}</span>}
                                  {p.documents.map((d, i) => (
                                    <span key={i} className="block truncate pl-3 text-slate-500">
                                      {d.description}
                                    </span>
                                  ))}
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-5 py-3 text-right tabular-nums text-slate-700">{fmt.format(w.amount)}</td>
                      <td className="whitespace-nowrap px-5 py-3 text-right tabular-nums text-slate-500">
                        {w.used > 0 ? fmt.format(w.used) : "—"}
                      </td>
                      <td
                        className={`whitespace-nowrap px-5 py-3 text-right font-medium tabular-nums ${
                          w.available > 0.01 ? "text-amber-700" : "text-emerald-700"
                        }`}
                      >
                        {w.available > 0.01 ? fmt.format(w.available) : "Justificado"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      </main>
    </div>
  );
}
