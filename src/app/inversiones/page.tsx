import Link from "next/link";
import { NavBar } from "@/components/nav-bar";
import { getInvestmentBreakdown } from "@/lib/queries";
import { Card, CardHeader, StatCard } from "@/components/ui";
import { IconArrowUpRight, IconArrowDownRight, IconAlertTriangle, IconArrowLeft } from "@/components/icons";

export const dynamic = "force-dynamic";

const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });
const CATEGORY = "Movimientos de fondos / inversiones propias";

export default async function InversionesPage() {
  const { plazoFijo, fci } = await getInvestmentBreakdown();

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
          <h1 className="text-xl font-semibold text-slate-900">Inversiones</h1>
          <p className="mt-1 text-sm text-slate-500">
            Plazo fijo y fondos comunes de inversión propios — qué entró, qué salió, y la ganancia aproximada donde
            se puede calcular.
          </p>
        </div>

        {/* ---- Plazo fijo ---- */}
        <Card className="mb-6">
          <CardHeader
            title="Plazo fijo"
            subtitle="Colocación (sale plata) vs. cobro al vencimiento (vuelve capital + interés)."
          />
          <div className="grid grid-cols-2 gap-4 px-6 py-5 sm:grid-cols-3">
            <StatCard
              label="Colocado"
              value={fmt.format(Math.abs(plazoFijo.colocaciones.total))}
              title={fmt.format(Math.abs(plazoFijo.colocaciones.total))}
              tone="neutral"
              icon={<IconArrowDownRight width={17} height={17} />}
            />
            <StatCard
              label="Cobrado al vencimiento"
              value={fmt.format(plazoFijo.cobros.total)}
              title={fmt.format(plazoFijo.cobros.total)}
              tone="neutral"
              icon={<IconArrowUpRight width={17} height={17} />}
            />
            <StatCard
              label="Ganancia aproximada"
              value={fmt.format(plazoFijo.gananciaAprox)}
              title={fmt.format(plazoFijo.gananciaAprox)}
              tone={plazoFijo.gananciaAprox >= 0 ? "success" : "danger"}
            />
          </div>
          <p className="px-6 pb-2 text-xs text-slate-500">
            {plazoFijo.colocaciones.count} colocación(es) · {plazoFijo.cobros.count} cobro(s) al vencimiento.
          </p>
          {plazoFijo.desbalanceado && (
            <div className="mx-6 mb-5 flex gap-2.5 rounded-xl bg-amber-50 px-4 py-3 text-xs text-amber-800">
              <IconAlertTriangle width={15} height={15} className="mt-0.5 shrink-0" />
              <p>
                Hay distinta cantidad de colocaciones que de cobros — algunos plazos fijos que vencieron en este
                período se constituyeron antes del rango de fechas importado, así que ese cobro trae capital que no
                se ve salir en ningún lado. La ganancia real de intereses probablemente es <strong>menor</strong> al
                número de arriba.
              </p>
            </div>
          )}
        </Card>

        {/* ---- Fondos comunes de inversión ---- */}
        <Card className="mb-6">
          <CardHeader
            title="Fondos comunes de inversión"
            subtitle="Suscripción (entra al fondo) vs. rescate (vuelve a la cuenta)."
          />
          <div className="grid grid-cols-2 gap-4 px-6 py-5 sm:grid-cols-3">
            <StatCard
              label="Suscripto"
              value={fmt.format(Math.abs(fci.suscripciones.total))}
              title={fmt.format(Math.abs(fci.suscripciones.total))}
              tone="neutral"
              icon={<IconArrowDownRight width={17} height={17} />}
            />
            <StatCard
              label="Rescatado"
              value={fmt.format(fci.rescates.total)}
              title={fmt.format(fci.rescates.total)}
              tone="neutral"
              icon={<IconArrowUpRight width={17} height={17} />}
            />
            <StatCard
              label="Neto (no es ganancia)"
              value={fmt.format(fci.neto)}
              title={fmt.format(fci.neto)}
              tone="neutral"
            />
          </div>
          <p className="px-6 pb-2 text-xs text-slate-500">
            {fci.suscripciones.count} suscripción(es) · {fci.rescates.count} rescate(s).
          </p>
          <div className="mx-6 mb-5 rounded-xl bg-slate-50 px-4 py-3 text-xs text-slate-600">
            Este neto <strong>no es una ganancia ni una pérdida</strong> — es sólo cuánta plata entró vs. cuánta
            volvió. Si el neto da negativo (suscribiste más de lo que rescataste) es porque todavía tenés plata
            puesta en el fondo, no porque la hayas perdido. Para saber el rendimiento real hace falta el valor actual
            de las cuotapartes que no se rescataron — un dato que viene del estado de cuenta del fondo (Macro
            Fondos / homebanking), no de los movimientos bancarios importados acá.
          </div>
        </Card>

        <Link
          href={`/categorizados/${encodeURIComponent(CATEGORY)}`}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-800"
        >
          Ver el detalle completo de estos movimientos, mes a mes
          <IconArrowUpRight width={12} height={12} className="rotate-45" />
        </Link>
      </main>
    </div>
  );
}
