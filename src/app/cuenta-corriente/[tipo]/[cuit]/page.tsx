import Link from "next/link";
import { notFound } from "next/navigation";
import { NavBar } from "@/components/nav-bar";
import { getAniosConComprobantes, type Source } from "@/lib/cuenta-corriente";
import {
  getLibroCuentaCorriente,
  type EstadoFactura,
  type LibroCuentaCorriente,
  type MovimientoLibro,
} from "@/lib/cuenta-corriente-libro";
import { Card, CardHeader, EmptyState, SourceBadge, StatCard } from "@/components/ui";
import { IconArrowLeft, IconFileText, IconCheckCircle, IconScale, IconClock, IconWallet } from "@/components/icons";

export const dynamic = "force-dynamic";

const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });
const fmtDate = new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeZone: "UTC" });
const fmtMes = new Intl.DateTimeFormat("es-AR", { month: "long", year: "numeric", timeZone: "UTC" });

const TIPO_TO_SOURCE: Record<string, Source> = {
  clientes: "afip_issued",
  proveedores: "afip_received",
};

const VISTAS = [
  { key: "movimientos", label: "Movimientos" },
  { key: "abiertas", label: "Facturas abiertas" },
  { key: "mes", label: "Por mes" },
] as const;
type Vista = (typeof VISTAS)[number]["key"];

const ESTADO_STYLES: Record<EstadoFactura, { bg: string; text: string; label: string }> = {
  pagada: { bg: "bg-emerald-100", text: "text-emerald-800", label: "Pagada" },
  revisar: { bg: "bg-amber-100", text: "text-amber-800", label: "Pendiente de revisar" },
  pendiente_pago: { bg: "bg-orange-100", text: "text-orange-800", label: "Pendiente de pago" },
  categorizada: { bg: "bg-sky-100", text: "text-sky-800", label: "Categorizada" },
  sin_conciliar: { bg: "bg-slate-100", text: "text-slate-600", label: "Sin conciliar" },
};

const formatCuit = (c: string) => (c.length === 11 ? `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}` : c);
const mesLabel = (key: string) => {
  const s = fmtMes.format(new Date(`${key}-01T00:00:00Z`));
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export default async function CuentaCorrienteDetallePage({
  params,
  searchParams,
}: {
  params: Promise<{ tipo: string; cuit: string }>;
  searchParams: Promise<{ anio?: string; vista?: string }>;
}) {
  const [{ tipo, cuit }, { anio: anioParam, vista: vistaParam }] = await Promise.all([params, searchParams]);
  const source = TIPO_TO_SOURCE[tipo];
  if (!source) notFound();

  const anios = await getAniosConComprobantes();
  const anio = anioParam && anios.includes(Number(anioParam)) ? Number(anioParam) : undefined;
  const vista: Vista = VISTAS.some((v) => v.key === vistaParam) ? (vistaParam as Vista) : "movimientos";

  const libro = await getLibroCuentaCorriente(source, cuit, { anio });
  if (!libro) notFound();

  const esCliente = tipo === "clientes";
  const base = `/cuenta-corriente/${tipo}/${cuit}`;
  const href = (p: { anio?: number; vista?: Vista }) => {
    const q = new URLSearchParams();
    if (p.anio !== undefined) q.set("anio", String(p.anio));
    if (p.vista && p.vista !== "movimientos") q.set("vista", p.vista);
    const s = q.toString();
    return s ? `${base}?${s}` : base;
  };
  const exportHref = `/api/cuenta-corriente/export?tipo=${tipo}&cuit=${cuit}${anio !== undefined ? `&anio=${anio}` : ""}`;
  const abiertasReales = libro.abiertas.filter((a) => a.estado !== "categorizada");
  const masVieja = abiertasReales[0];

  return (
    <div className="flex min-h-screen flex-col">
      <NavBar />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
        <Link
          href={anio !== undefined ? `/cuenta-corriente?anio=${anio}` : "/cuenta-corriente"}
          className="mb-4 inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-800"
        >
          <IconArrowLeft width={13} height={13} />
          Volver a Cuenta corriente
        </Link>

        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">{esCliente ? "Cliente" : "Proveedor"}</p>
            <h1 className="mt-1 text-xl font-semibold text-slate-900">{libro.denominacion}</h1>
            <p className="mt-1 text-sm text-slate-500">
              CUIT {formatCuit(cuit)}
              {libro.ultimoComprobante && <> · Último comprobante {fmtDate.format(libro.ultimoComprobante)}</>}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <PeriodoChip href={href({ vista })} label="Todo" active={anio === undefined} />
            {anios.map((a) => (
              <PeriodoChip key={a} href={href({ anio: a, vista })} label={String(a)} active={anio === a} />
            ))}
            <a
              href={exportHref}
              className="ml-2 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700"
            >
              Exportar a Excel
            </a>
          </div>
        </div>

        <div className={`mb-6 grid grid-cols-2 gap-4 ${esCliente ? "sm:grid-cols-5" : "sm:grid-cols-4"}`}>
          <StatCard
            label="Facturado (neto de NC)"
            value={fmt.format(libro.totales.facturado)}
            tone="neutral"
            icon={<IconFileText width={17} height={17} />}
          />
          <StatCard
            label={esCliente ? "Cobrado" : "Pagado"}
            value={fmt.format(libro.totales.pagado)}
            tone="success"
            icon={<IconCheckCircle width={17} height={17} />}
          />
          {esCliente && (
            <StatCard
              label="Retenciones"
              value={fmt.format(libro.totales.retenciones)}
              tone="neutral"
              icon={<IconWallet width={17} height={17} />}
            />
          )}
          <StatCard
            label={esCliente ? "Saldo a cobrar" : "Saldo a pagar"}
            value={fmt.format(libro.totales.saldo)}
            tone={libro.totales.saldo > 0.5 ? "warning" : "success"}
            icon={<IconScale width={17} height={17} />}
          />
          <StatCard
            label="Facturas abiertas"
            value={
              abiertasReales.length === 0
                ? "Ninguna"
                : `${abiertasReales.length} · la más vieja ${masVieja.dias} días`
            }
            tone={abiertasReales.length > 0 ? "warning" : "neutral"}
            icon={<IconClock width={17} height={17} />}
          />
        </div>

        <div className="mb-4 flex gap-1 border-b border-slate-200">
          {VISTAS.map((v) => (
            <Link
              key={v.key}
              href={href({ anio, vista: v.key })}
              className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${
                vista === v.key ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
            >
              {v.label}
              {v.key === "abiertas" && libro.abiertas.length > 0 && (
                <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{libro.abiertas.length}</span>
              )}
            </Link>
          ))}
        </div>

        {vista === "movimientos" && <Movimientos libro={libro} esCliente={esCliente} />}
        {vista === "abiertas" && <Abiertas libro={libro} />}
        {vista === "mes" && <PorMes libro={libro} esCliente={esCliente} />}
      </main>
    </div>
  );
}

function Movimientos({ libro, esCliente }: { libro: LibroCuentaCorriente; esCliente: boolean }) {
  if (libro.movimientos.length === 0) {
    return (
      <Card>
        <EmptyState icon={<IconScale width={20} height={20} />} title="Sin movimientos en este período" description="Probá con otro año o con Todo." />
      </Card>
    );
  }

  // Agrupado por mes: cada mes arranca con el saldo que traía del anterior.
  const grupos: { mes: string; saldoInicio: number; movs: MovimientoLibro[] }[] = [];
  let saldoPrevio = libro.saldoAnterior;
  for (const m of libro.movimientos) {
    const mes = m.fecha.toISOString().slice(0, 7);
    let g = grupos[grupos.length - 1];
    if (!g || g.mes !== mes) {
      g = { mes, saldoInicio: saldoPrevio, movs: [] };
      grupos.push(g);
    }
    g.movs.push(m);
    saldoPrevio = m.saldo;
  }

  return (
    <Card>
      <CardHeader
        title="Libro de movimientos"
        subtitle={`Facturas al Debe; ${esCliente ? "cobros, retenciones" : "pagos"} y notas de crédito al Haber. El saldo es lo que ${
          esCliente ? "te deben" : "le debés"
        } después de cada renglón.`}
      />
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-slate-400">
          <tr>
            <th className="px-6 py-2.5 font-medium">Fecha</th>
            <th className="px-6 py-2.5 font-medium">Concepto</th>
            <th className="px-6 py-2.5 text-right font-medium">Debe</th>
            <th className="px-6 py-2.5 text-right font-medium">Haber</th>
            <th className="px-6 py-2.5 text-right font-medium">Saldo</th>
          </tr>
        </thead>
        {grupos.map((g) => (
          <tbody key={g.mes}>
            <tr className="border-t border-slate-200 bg-slate-50">
              <td colSpan={4} className="px-6 py-2 text-xs font-semibold text-slate-700">
                {mesLabel(g.mes)}
                <span className="ml-2 font-normal text-slate-400">saldo anterior</span>
              </td>
              <td className="px-6 py-2 text-right text-xs font-semibold tabular-nums text-slate-500">{fmt.format(g.saldoInicio)}</td>
            </tr>
            {g.movs.map((m) => (
              <tr key={m.id} className="border-t border-slate-100">
                <td className="whitespace-nowrap px-6 py-2.5 text-slate-500">{fmtDate.format(m.fecha)}</td>
                <td className="px-6 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    {m.fuente && <SourceBadge source={m.fuente} />}
                    <span className={m.tipo === "factura" ? "font-medium text-slate-800" : "text-slate-700"}>
                      {m.tipo === "nota_credito" ? `Nota de crédito · ${m.concepto}` : m.concepto}
                    </span>
                    {m.estado && <EstadoBadge estado={m.estado} categoria={m.categoria} />}
                  </div>
                  {m.detalle && <p className="mt-0.5 text-xs text-slate-400">{m.detalle}</p>}
                </td>
                <td className="whitespace-nowrap px-6 py-2.5 text-right tabular-nums text-slate-700">{m.debe ? fmt.format(m.debe) : ""}</td>
                <td className="whitespace-nowrap px-6 py-2.5 text-right tabular-nums text-emerald-700">{m.haber ? fmt.format(m.haber) : ""}</td>
                <td
                  className={`whitespace-nowrap px-6 py-2.5 text-right font-medium tabular-nums ${
                    m.saldo > 0.5 ? "text-rose-600" : m.saldo < -0.5 ? "text-emerald-600" : "text-slate-400"
                  }`}
                >
                  {fmt.format(m.saldo)}
                </td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </Card>
  );
}

function Abiertas({ libro }: { libro: LibroCuentaCorriente }) {
  if (libro.abiertas.length === 0) {
    return (
      <Card>
        <EmptyState icon={<IconCheckCircle width={20} height={20} />} title="No hay facturas abiertas" description="Todas las facturas del período están conciliadas." />
      </Card>
    );
  }
  const total = libro.abiertas.reduce((acc, a) => acc + a.importe, 0);
  return (
    <Card>
      <CardHeader title="Facturas abiertas" subtitle={`Sin pago conciliado, de la más vieja a la más nueva. Total ${fmt.format(total)}.`} />
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-slate-400">
          <tr>
            <th className="px-6 py-2.5 font-medium">Fecha</th>
            <th className="px-6 py-2.5 font-medium">Comprobante</th>
            <th className="px-6 py-2.5 text-right font-medium">Importe</th>
            <th className="px-6 py-2.5 text-right font-medium">Antigüedad</th>
            <th className="px-6 py-2.5 font-medium">Estado</th>
          </tr>
        </thead>
        <tbody>
          {libro.abiertas.map((a) => (
            <tr key={a.txn.id} className="border-t border-slate-100">
              <td className="whitespace-nowrap px-6 py-2.5 text-slate-500">{fmtDate.format(a.txn.date)}</td>
              <td className="px-6 py-2.5 font-medium text-slate-800">{a.numero}</td>
              <td className="whitespace-nowrap px-6 py-2.5 text-right tabular-nums text-slate-700">{fmt.format(a.importe)}</td>
              <td
                className={`whitespace-nowrap px-6 py-2.5 text-right tabular-nums ${
                  a.dias > 90 ? "font-semibold text-rose-600" : a.dias > 30 ? "text-amber-700" : "text-slate-500"
                }`}
              >
                {a.dias} días
              </td>
              <td className="whitespace-nowrap px-6 py-2.5">
                <EstadoBadge estado={a.estado} categoria={a.categoria} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function PorMes({ libro, esCliente }: { libro: LibroCuentaCorriente; esCliente: boolean }) {
  if (libro.meses.length === 0) {
    return (
      <Card>
        <EmptyState icon={<IconScale width={20} height={20} />} title="Sin movimientos en este período" description="Probá con otro año o con Todo." />
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader title="Resumen por mes" subtitle="Lo facturado y lo cancelado cada mes, con el saldo al cierre." />
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-slate-400">
          <tr>
            <th className="px-6 py-2.5 font-medium">Mes</th>
            <th className="px-6 py-2.5 text-right font-medium">Facturado</th>
            <th className="px-6 py-2.5 text-right font-medium">{esCliente ? "Cobrado + NC" : "Pagado + NC"}</th>
            <th className="px-6 py-2.5 text-right font-medium">Saldo al cierre</th>
          </tr>
        </thead>
        <tbody>
          {libro.meses.map((m) => (
            <tr key={m.mes} className="border-t border-slate-100">
              <td className="px-6 py-2.5 font-medium text-slate-700">{mesLabel(m.mes)}</td>
              <td className="whitespace-nowrap px-6 py-2.5 text-right tabular-nums text-slate-700">{fmt.format(m.debe)}</td>
              <td className="whitespace-nowrap px-6 py-2.5 text-right tabular-nums text-emerald-700">{fmt.format(m.haber)}</td>
              <td
                className={`whitespace-nowrap px-6 py-2.5 text-right font-medium tabular-nums ${
                  m.saldo > 0.5 ? "text-rose-600" : m.saldo < -0.5 ? "text-emerald-600" : "text-slate-400"
                }`}
              >
                {fmt.format(m.saldo)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function EstadoBadge({ estado, categoria }: { estado: EstadoFactura; categoria?: string | null }) {
  const style = ESTADO_STYLES[estado];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${style.bg} ${style.text}`}
      title={estado === "categorizada" && categoria ? categoria : undefined}
    >
      {estado === "categorizada" && categoria ? categoria : style.label}
    </span>
  );
}

function PeriodoChip({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`rounded-full px-3 py-1 text-xs font-semibold ${
        active ? "bg-indigo-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
      }`}
    >
      {label}
    </Link>
  );
}
