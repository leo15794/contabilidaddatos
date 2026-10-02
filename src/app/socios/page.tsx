import Link from "next/link";
import { NavBar } from "@/components/nav-bar";
import { getPartnersSummary } from "@/lib/partners";
import { Card, CardHeader, Amount, EmptyState } from "@/components/ui";
import { NewPartnerForm } from "./new-partner-form";
import { IconUsers } from "@/components/icons";

export const dynamic = "force-dynamic";

const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });
const MES_ACTUAL = new Intl.DateTimeFormat("es-AR", { month: "long", year: "numeric" }).format(new Date());

export default async function SociosPage() {
  const summaries = await getPartnersSummary();

  return (
    <div className="flex min-h-screen flex-col">
      <NavBar />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-slate-900">Socios</h1>
          <p className="text-sm text-slate-500">
            Gastos de tarjeta atribuidos a cada socio, mes a mes ({MES_ACTUAL}).
          </p>
        </div>

        <Card className="mb-6">
          <CardHeader
            title="Agregar socio"
            subtitle="El nombre tiene que ser igual al del titular en el resumen de tarjeta — así sus consumos se le atribuyen solos."
          />
          <div className="px-5 py-4">
            <NewPartnerForm />
          </div>
        </Card>

        <Card>
          <CardHeader title="Socios" />
          {summaries.length === 0 ? (
            <EmptyState
              icon={<IconUsers width={20} height={20} />}
              title="Todavía no agregaste ningún socio"
              description="Agregá uno arriba con el mismo nombre que aparece como titular en algún resumen de tarjeta."
            />
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Socio</th>
                  <th className="px-5 py-2.5 font-medium">Gastado este mes</th>
                  <th className="px-5 py-2.5 font-medium">Saldo asignado</th>
                  <th className="px-5 py-2.5 font-medium">Restante</th>
                </tr>
              </thead>
              <tbody>
                {summaries.map(({ partner, spentThisMonth, balanceThisMonth, remaining }) => (
                  <tr key={partner.id} className="border-t border-slate-100 hover:bg-slate-50/80">
                    <td className="px-5 py-3">
                      <Link
                        href={`/socios/${partner.id}`}
                        className="font-medium text-slate-800 hover:text-indigo-600"
                      >
                        {partner.name}
                      </Link>
                    </td>
                    <td className="px-5 py-3">
                      <Amount value={-spentThisMonth} />
                    </td>
                    <td className="px-5 py-3 text-slate-600">
                      {balanceThisMonth === null ? (
                        <span className="text-xs text-slate-400">Sin asignar</span>
                      ) : (
                        fmt.format(balanceThisMonth)
                      )}
                    </td>
                    <td className="px-5 py-3">
                      {remaining === null ? (
                        <span className="text-xs text-slate-400">—</span>
                      ) : (
                        <Amount value={remaining} />
                      )}
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
