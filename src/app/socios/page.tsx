import Link from "next/link";
import { NavBar } from "@/components/nav-bar";
import { getPartnersSummary } from "@/lib/partners";
import { Card, CardHeader, Amount, EmptyState } from "@/components/ui";
import { NewPartnerForm } from "./new-partner-form";
import { IconUsers } from "@/components/icons";

export const dynamic = "force-dynamic";

const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });
const MES_ACTUAL = new Intl.DateTimeFormat("es-AR", { month: "long", year: "numeric" }).format(new Date());

// Un gradiente de avatar distinto por posición, para que la grilla de
// socios no quede toda del mismo color — cicla si hay más socios que
// colores (nunca se le asigna uno fijo a una persona, así que no hace
// falta mapear nombre -> color).
const AVATAR_GRADIENTS = [
  "from-indigo-600 to-violet-500",
  "from-slate-900 to-slate-700",
  "from-teal-600 to-emerald-500",
  "from-rose-600 to-orange-500",
  "from-cyan-600 to-blue-500",
];

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

export default async function SociosPage() {
  const summaries = await getPartnersSummary();

  return (
    <div className="flex min-h-screen flex-col">
      <NavBar />

      <div className="bg-gradient-to-br from-indigo-50 via-violet-50/70 to-slate-50 px-4 pb-8 pt-10">
        <div className="mx-auto w-full max-w-5xl">
          <h1 className="text-[32px] font-extrabold tracking-tight text-slate-900">Socios</h1>
          <p className="mt-1 text-sm text-slate-500">
            Gastos de tarjeta atribuidos a cada socio, mes a mes ({MES_ACTUAL}).
          </p>
        </div>
      </div>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <Card className="mb-7">
          <CardHeader
            title="Agregar socio"
            subtitle="El nombre tiene que ser igual al del titular en el resumen de tarjeta — así sus consumos se le atribuyen solos. Si el banco lo imprime distinto, se puede cargar un alias después, desde el detalle del socio."
          />
          <div className="px-6 py-5">
            <NewPartnerForm />
          </div>
        </Card>

        {summaries.length === 0 ? (
          <Card>
            <EmptyState
              icon={<IconUsers width={20} height={20} />}
              title="Todavía no agregaste ningún socio"
              description="Agregá uno arriba con el mismo nombre que aparece como titular en algún resumen de tarjeta."
            />
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {summaries.map(({ partner, spentThisMonth, balanceThisMonth, remaining }, i) => {
              const over = remaining !== null && remaining < 0;
              const pct =
                balanceThisMonth && balanceThisMonth > 0
                  ? Math.min(100, Math.round((spentThisMonth / balanceThisMonth) * 100))
                  : 0;
              return (
                <Card
                  key={partner.id}
                  className={`px-6 py-6 ${over ? "border-rose-200" : ""}`}
                >
                  <div className="mb-4.5 flex items-center gap-3">
                    <div
                      className={`flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-[15px] font-bold text-white ${AVATAR_GRADIENTS[i % AVATAR_GRADIENTS.length]}`}
                    >
                      {initials(partner.name)}
                    </div>
                    <div className="min-w-0">
                      <Link
                        href={`/socios/${partner.id}`}
                        className="block truncate text-[15px] font-bold text-slate-900 hover:text-indigo-600"
                      >
                        {partner.name}
                      </Link>
                      <p className="text-[11.5px] text-slate-400">Socio</p>
                    </div>
                  </div>

                  <div className="mb-1 flex items-center justify-between text-xs text-slate-400">
                    <span>Gastado este mes</span>
                    <span>{balanceThisMonth === null ? "Sin saldo asignado" : `Saldo ${fmt.format(balanceThisMonth)}`}</span>
                  </div>
                  <p className="mb-2.5 text-[19px] font-bold tabular-nums text-rose-600">
                    <Amount value={-spentThisMonth} />
                  </p>

                  {balanceThisMonth !== null && (
                    <div className="mb-2.5 h-[7px] w-full overflow-hidden rounded-full bg-slate-100">
                      <div
                        className={`h-full rounded-full ${over ? "bg-rose-600" : "bg-indigo-600"}`}
                        style={{ width: `${over ? 100 : pct}%` }}
                      />
                    </div>
                  )}

                  <div className="flex items-center justify-between">
                    <p className="text-xs text-slate-500">
                      Restante{" "}
                      {remaining === null ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        <span className={`font-bold ${over ? "text-rose-600" : "text-emerald-600"}`}>
                          {fmt.format(remaining)}
                        </span>
                      )}
                    </p>
                    <Link href={`/socios/${partner.id}`} className="text-xs font-semibold">
                      Ver detalle →
                    </Link>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
