import Link from "next/link";
import { notFound } from "next/navigation";
import { NavBar } from "@/components/nav-bar";
import { getAniosConComprobantes, type Source } from "@/lib/cuenta-corriente";
import {
  getLibroCuentaCorriente,
  type EstadoFactura,
  type FacturaAbierta,
  type LibroCuentaCorriente,
  type MovimientoLibro,
} from "@/lib/cuenta-corriente-libro";
import { SourceBadge } from "@/components/ui";
import { CopyClaimButton } from "./copy-claim-button";

export const dynamic = "force-dynamic";

const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });
const fmtCompact = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });
const fmtDate = new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeZone: "UTC" });
const fmtMesCorto = new Intl.DateTimeFormat("es-AR", { month: "short", year: "numeric", timeZone: "UTC" });
const fmtMes = new Intl.DateTimeFormat("es-AR", { month: "long", year: "numeric", timeZone: "UTC" });
const fmtM = (n: number) => `$ ${(n / 1_000_000).toLocaleString("es-AR", { maximumFractionDigits: 2 })} M`;

const DAY_MS = 24 * 60 * 60 * 1000;
// Plazo con el que una factura pasa de "en plazo" a "vencida". Los clientes pagan a 30 días.
const PLAZO_DIAS = 30;

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

const formatCuit = (c: string) => (c.length === 11 ? `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}` : c);
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const mesLabel = (key: string) => capitalize(fmtMes.format(new Date(`${key}-01T00:00:00Z`)));
const diasDesde = (d: Date) => Math.floor((Date.now() - d.getTime()) / DAY_MS);

function initials(name: string) {
  const words = name.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ ]/g, " ").trim().split(/\s+/).filter((w) => w.length > 2);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase() || "?";
}

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

  // El saldo y la antigüedad son siempre al día de hoy (todo el historial); el período solo filtra el libro.
  const [libro, total] = await Promise.all([
    getLibroCuentaCorriente(source, cuit, { anio }),
    anio !== undefined ? getLibroCuentaCorriente(source, cuit, {}) : null,
  ]);
  if (!libro) notFound();
  const todo = total ?? libro;

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

  // Antigüedad de lo que está abierto hoy (lo categorizado ya se resolvió por otro lado).
  const abiertas = todo.abiertas.filter((a) => a.estado !== "categorizada");
  const aging = {
    d0_30: abiertas.filter((a) => a.dias <= PLAZO_DIAS).reduce((s, a) => s + a.importe, 0),
    d31_90: abiertas.filter((a) => a.dias > PLAZO_DIAS && a.dias <= 90).reduce((s, a) => s + a.importe, 0),
    d90: abiertas.filter((a) => a.dias > 90).reduce((s, a) => s + a.importe, 0),
  };
  const agingTotal = aging.d0_30 + aging.d31_90 + aging.d90;
  const vencidas = abiertas.filter((a) => a.dias > PLAZO_DIAS);
  const vencidoTotal = vencidas.reduce((s, a) => s + a.importe, 0);
  // Lo que queda del saldo fuera de las facturas abiertas: retenciones que el cliente descontó
  // al pagar y cuyo certificado todavía no se cargó (sin certificado el cobro no cierra entero).
  const sinCertificado = esCliente ? Math.max(0, todo.totales.saldo - todo.abiertas.reduce((s, a) => s + a.importe, 0)) : 0;

  const pagos = todo.movimientos.filter((m) => m.tipo === "pago");
  const ultimoPago = pagos[pagos.length - 1];
  const primerMov = todo.movimientos[0];
  const contexto = [
    `CUIT ${formatCuit(cuit)}`,
    primerMov ? `${esCliente ? "Cliente" : "Proveedor"} desde ${fmtMesCorto.format(primerMov.fecha)}` : null,
    pagos.length > 0
      ? `${pagos.length} ${esCliente ? "cobros" : "pagos"} · último ${fmtDate.format(ultimoPago.fecha)}`
      : `Sin ${esCliente ? "cobros" : "pagos"} registrados`,
    esCliente && todo.totales.retenciones > 0 ? "Retiene impuestos al pagar" : null,
  ].filter(Boolean);

  const reclamo = esCliente && vencidas.length > 0 ? claimText(libro.denominacion, vencidas, vencidoTotal) : null;

  return (
    <div className="flex min-h-screen flex-col">
      <NavBar />
      <main className="mx-auto w-full max-w-[1180px] flex-1 px-5 py-7 lg:px-9">
        <p className="text-[12.5px] font-medium text-slate-400">
          <Link href={anio !== undefined ? `/cuenta-corriente?anio=${anio}` : "/cuenta-corriente"} className="hover:text-slate-700">
            {esCliente ? "Clientes" : "Proveedores"}
          </Link>{" "}
          / <span className="text-slate-600">{libro.denominacion}</span>
        </p>

        {/* Encabezado */}
        <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <span
              className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br text-[15px] font-bold text-white ${
                esCliente ? "from-teal-500 to-emerald-500" : "from-indigo-500 to-violet-500"
              }`}
            >
              {initials(libro.denominacion)}
            </span>
            <div className="min-w-0">
              <h1 className="text-[22px] font-bold tracking-tight text-slate-900">{libro.denominacion}</h1>
              <p className="mt-0.5 text-[12.5px] text-slate-500">{contexto.join(" · ")}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <a href={exportHref} className="rounded-lg bg-white px-3.5 py-2 text-[12.5px] font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50">
              Exportar Excel
            </a>
            {reclamo && (
              <CopyClaimButton
                text={reclamo}
                label="Copiar reclamo"
                className="rounded-lg bg-indigo-600 px-3.5 py-2 text-[12.5px] font-semibold text-white shadow-sm hover:bg-indigo-700"
              />
            )}
          </div>
        </div>

        {/* Tarjetas */}
        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-[1.25fr_1fr_1fr_1fr]">
          <div className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
            <div className="flex items-baseline justify-between">
              <p className="text-[12.5px] font-medium text-slate-500">{esCliente ? "Saldo a cobrar" : "Saldo a pagar"}</p>
              <p className="text-[11.5px] text-slate-400">al {fmtDate.format(new Date())}</p>
            </div>
            <p className={`mt-1 text-[28px] font-extrabold tracking-tight tabular-nums ${todo.totales.saldo > 0.5 ? "text-slate-900" : "text-emerald-600"}`}>
              {fmt.format(todo.totales.saldo)}
            </p>
            {agingTotal > 0 ? (
              <>
                <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-slate-100">
                  <div className="bg-emerald-400" style={{ width: `${(aging.d0_30 / agingTotal) * 100}%` }} />
                  <div className="bg-amber-400" style={{ width: `${(aging.d31_90 / agingTotal) * 100}%` }} />
                  <div className="bg-rose-400" style={{ width: `${(aging.d90 / agingTotal) * 100}%` }} />
                </div>
                <div className="mt-2 flex flex-wrap justify-between gap-x-3 text-[11px] tabular-nums text-slate-500">
                  <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-400" />0–30 {fmtM(aging.d0_30)}</span>
                  <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-amber-400" />31–90 {fmtM(aging.d31_90)}</span>
                  <span><i className="mr-1 inline-block h-2 w-2 rounded-full bg-rose-400" />+90 {fmtM(aging.d90)}</span>
                </div>
              </>
            ) : (
              <p className="mt-2 text-[12px] text-emerald-600">Sin facturas abiertas ✓</p>
            )}
            {sinCertificado > 1 && (
              <p className="mt-2 text-[11.5px] text-slate-500">
                Incluye {fmt.format(sinCertificado)} de retenciones sin certificado cargado
              </p>
            )}
          </div>
          <Kpi label={`Facturado${anio ? ` (${anio})` : ""}`} value={fmtCompact.format(libro.totales.facturado)} sub="neto de notas de crédito" />
          <Kpi
            label={`${esCliente ? "Cobrado" : "Pagado"}${anio ? ` (${anio})` : ""}`}
            value={fmtCompact.format(libro.totales.pagado)}
            sub={`${libro.movimientos.filter((m) => m.tipo === "pago").length} movimientos`}
            tone="text-emerald-600"
          />
          {esCliente ? (
            <Kpi
              label="Retenciones"
              value={fmtCompact.format(libro.totales.retenciones)}
              sub={sinCertificado > 1 ? `faltan certificados por ${fmtCompact.format(sinCertificado)}` : "certificados cargados"}
              tone={sinCertificado > 1 ? "text-amber-600" : "text-slate-900"}
            />
          ) : (
            <Kpi
              label="Facturas abiertas"
              value={String(abiertas.length)}
              sub={abiertas[0] ? `la más vieja tiene ${abiertas[0].dias} días` : "ninguna"}
              tone={abiertas.length > 0 ? "text-amber-600" : "text-slate-900"}
            />
          )}
        </div>

        {/* Pestañas + período */}
        <div className="mt-6 flex flex-wrap items-end justify-between gap-3 border-b border-slate-200">
          <div className="flex gap-6 text-[13.5px] font-medium">
            {VISTAS.map((v) => (
              <Link
                key={v.key}
                href={href({ anio, vista: v.key })}
                className={`-mb-px border-b-2 pb-2.5 ${vista === v.key ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}
              >
                {v.label}
                {v.key === "abiertas" && abiertas.length > 0 && (
                  <span className="ml-1.5 rounded-full bg-rose-100 px-1.5 text-[11px] font-semibold text-rose-700">{abiertas.length}</span>
                )}
              </Link>
            ))}
          </div>
          <div className="flex gap-1.5 pb-2 text-[12px] font-medium">
            <PeriodoChip href={href({ vista })} label="Todo" active={anio === undefined} />
            {anios.map((a) => (
              <PeriodoChip key={a} href={href({ anio: a, vista })} label={String(a)} active={anio === a} />
            ))}
          </div>
        </div>

        <div className="mt-4">
          {vista === "movimientos" && <Movimientos libro={libro} esCliente={esCliente} />}
          {vista === "abiertas" && <Abiertas abiertas={todo.abiertas} />}
          {vista === "mes" && <PorMes libro={libro} esCliente={esCliente} />}
        </div>

        {reclamo && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-indigo-50 px-5 py-3.5 ring-1 ring-indigo-100">
            <p className="text-[12.5px] text-indigo-900">
              <span className="font-semibold">Para el reclamo:</span> {vencidas.length}{" "}
              {vencidas.length === 1 ? "factura vencida" : "facturas vencidas"} por {fmt.format(vencidoTotal)}.
            </p>
            <CopyClaimButton
              text={reclamo}
              className="rounded-lg bg-indigo-600 px-3.5 py-1.5 text-[12.5px] font-semibold text-white hover:bg-indigo-700"
            />
          </div>
        )}
      </main>
    </div>
  );
}

function Kpi({ label, value, sub, tone = "text-slate-900" }: { label: string; value: string; sub: string; tone?: string }) {
  return (
    <div className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
      <p className="text-[12.5px] font-medium text-slate-500">{label}</p>
      <p className={`mt-1 text-[22px] font-bold tabular-nums ${tone}`}>{value}</p>
      <p className="mt-1 text-[12px] text-slate-400">{sub}</p>
    </div>
  );
}

/** Estado de una factura en lenguaje de cobranza: pagada, en plazo o vencida hace tantos días. */
function EstadoBadge({ estado, fecha, categoria }: { estado: EstadoFactura; fecha: Date; categoria?: string | null }) {
  if (estado === "pagada") return <Badge tone="bg-emerald-50 text-emerald-700">Pagada</Badge>;
  if (estado === "categorizada") return <Badge tone="bg-sky-50 text-sky-700">{categoria ?? "Categorizada"}</Badge>;
  if (estado === "revisar") return <Badge tone="bg-indigo-50 text-indigo-700">Para revisar</Badge>;
  const dias = diasDesde(fecha);
  if (dias <= PLAZO_DIAS) return <Badge tone="bg-slate-100 text-slate-600">En plazo · {dias} días</Badge>;
  return <Badge tone={dias > 90 ? "bg-rose-50 text-rose-700" : "bg-amber-50 text-amber-700"}>Vencida · {dias} días</Badge>;
}

function Badge({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}>{children}</span>;
}

function Movimientos({ libro, esCliente }: { libro: LibroCuentaCorriente; esCliente: boolean }) {
  if (libro.movimientos.length === 0) return <Vacio texto="Sin movimientos en este período. Probá con otro año o con Todo." />;

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
  // Lo más reciente arriba: es lo que se mira primero.
  grupos.reverse();

  return (
    <div className="overflow-x-auto rounded-2xl bg-white ring-1 ring-slate-200">
      <table className="w-full min-w-[760px] text-[12.5px]">
        <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wider text-slate-400">
          <tr>
            <th className="px-5 py-2.5 font-medium">Fecha</th>
            <th className="px-3 py-2.5 font-medium">Concepto</th>
            <th className="px-3 py-2.5 font-medium">Estado</th>
            <th className="px-3 py-2.5 text-right font-medium">Debe</th>
            <th className="px-3 py-2.5 text-right font-medium">Haber</th>
            <th className="px-5 py-2.5 text-right font-medium">Saldo</th>
          </tr>
        </thead>
        {grupos.map((g) => (
          <tbody key={g.mes} className="tabular-nums">
            <tr className="border-t border-slate-200 bg-slate-50/70">
              <td colSpan={5} className="px-5 py-2 text-[11.5px] font-semibold text-slate-500">
                {mesLabel(g.mes)} <span className="font-normal text-slate-400">· saldo anterior</span>
              </td>
              <td className="px-5 text-right text-[11.5px] font-semibold text-slate-500">{fmt.format(g.saldoInicio)}</td>
            </tr>
            {g.movs.map((m) => (
              <tr key={m.id} className="border-t border-slate-100 align-top">
                <td className="whitespace-nowrap px-5 py-2.5 text-slate-500">{fmtDate.format(m.fecha)}</td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    {m.fuente && <SourceBadge source={m.fuente} />}
                    <span className={m.tipo === "factura" ? "font-medium text-slate-800" : "text-slate-700"}>
                      {m.tipo === "nota_credito" ? `Nota de crédito · ${m.concepto}` : m.concepto}
                    </span>
                  </div>
                  {m.detalle && <p className="mt-0.5 text-[11.5px] text-slate-400">{m.detalle}</p>}
                </td>
                <td className="px-3 py-2.5">
                  {m.estado ? (
                    <EstadoBadge estado={m.estado} fecha={m.fecha} categoria={m.categoria} />
                  ) : m.tipo === "pago" || m.tipo === "retencion" ? (
                    <Badge tone="bg-emerald-50 text-emerald-700">Conciliado</Badge>
                  ) : null}
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 text-right text-slate-700">{m.debe ? fmt.format(m.debe) : <span className="text-slate-300">—</span>}</td>
                <td className="whitespace-nowrap px-3 py-2.5 text-right text-emerald-700">{m.haber ? fmt.format(m.haber) : <span className="text-slate-300">—</span>}</td>
                <td className={`whitespace-nowrap px-5 py-2.5 text-right font-medium ${m.saldo > 0.5 ? "text-slate-900" : "text-emerald-600"}`}>
                  {fmt.format(m.saldo)}
                </td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
      <p className="border-t border-slate-100 px-5 py-2.5 text-[11.5px] text-slate-400">
        Facturas al Debe; {esCliente ? "cobros y retenciones" : "pagos"} y notas de crédito al Haber. El saldo es lo que{" "}
        {esCliente ? "te deben" : "le debés"} después de cada renglón.
      </p>
    </div>
  );
}

function Abiertas({ abiertas }: { abiertas: FacturaAbierta[] }) {
  if (abiertas.length === 0) return <Vacio texto="No hay facturas abiertas. Todo cobrado ✓" />;
  const total = abiertas.reduce((s, a) => s + a.importe, 0);
  return (
    <div className="overflow-x-auto rounded-2xl bg-white ring-1 ring-slate-200">
      <table className="w-full min-w-[620px] text-[12.5px]">
        <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wider text-slate-400">
          <tr>
            <th className="px-5 py-2.5 font-medium">Fecha</th>
            <th className="px-3 py-2.5 font-medium">Comprobante</th>
            <th className="px-3 py-2.5 font-medium">Estado</th>
            <th className="px-5 py-2.5 text-right font-medium">Importe</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {abiertas.map((a) => (
            <tr key={a.txn.id} className="border-t border-slate-100">
              <td className="whitespace-nowrap px-5 py-2.5 text-slate-500">{fmtDate.format(a.txn.date)}</td>
              <td className="px-3 py-2.5 font-medium text-slate-800">{a.numero}</td>
              <td className="px-3 py-2.5">
                <EstadoBadge estado={a.estado} fecha={a.txn.date} categoria={a.categoria} />
              </td>
              <td className="whitespace-nowrap px-5 py-2.5 text-right font-medium">{fmt.format(a.importe)}</td>
            </tr>
          ))}
          <tr className="border-t border-slate-200 bg-slate-50/70 font-semibold">
            <td className="px-5 py-2.5" colSpan={3}>
              Total abierto
            </td>
            <td className="px-5 text-right">{fmt.format(total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function PorMes({ libro, esCliente }: { libro: LibroCuentaCorriente; esCliente: boolean }) {
  if (libro.meses.length === 0) return <Vacio texto="Sin movimientos en este período." />;
  const max = Math.max(...libro.meses.map((m) => Math.max(m.debe, m.haber)), 1);
  return (
    <div className="overflow-x-auto rounded-2xl bg-white ring-1 ring-slate-200">
      <table className="w-full min-w-[640px] text-[12.5px]">
        <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wider text-slate-400">
          <tr>
            <th className="px-5 py-2.5 font-medium">Mes</th>
            <th className="px-3 py-2.5 font-medium">Facturado vs. {esCliente ? "cobrado" : "pagado"}</th>
            <th className="px-3 py-2.5 text-right font-medium">Facturado</th>
            <th className="px-3 py-2.5 text-right font-medium">{esCliente ? "Cobrado" : "Pagado"} + NC</th>
            <th className="px-5 py-2.5 text-right font-medium">Saldo al cierre</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {[...libro.meses].reverse().map((m) => (
            <tr key={m.mes} className="border-t border-slate-100">
              <td className="whitespace-nowrap px-5 py-2.5 font-medium text-slate-700">{mesLabel(m.mes)}</td>
              <td className="w-[30%] px-3 py-2.5">
                <div className="space-y-1">
                  <div className="h-1.5 rounded-full bg-slate-300" style={{ width: `${(m.debe / max) * 100}%` }} />
                  <div className="h-1.5 rounded-full bg-emerald-400" style={{ width: `${(m.haber / max) * 100}%` }} />
                </div>
              </td>
              <td className="whitespace-nowrap px-3 py-2.5 text-right">{fmt.format(m.debe)}</td>
              <td className="whitespace-nowrap px-3 py-2.5 text-right text-emerald-700">{fmt.format(m.haber)}</td>
              <td className={`whitespace-nowrap px-5 py-2.5 text-right font-medium ${m.saldo > 0.5 ? "text-slate-900" : "text-emerald-600"}`}>
                {fmt.format(m.saldo)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Vacio({ texto }: { texto: string }) {
  return <p className="rounded-2xl bg-white px-6 py-10 text-center text-[13px] text-slate-500 ring-1 ring-slate-200">{texto}</p>;
}

function PeriodoChip({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`rounded-full px-3 py-1 ${active ? "bg-slate-900 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"}`}
    >
      {label}
    </Link>
  );
}

/** Texto para mandar por mail o WhatsApp con el detalle de lo vencido. */
function claimText(nombre: string, vencidas: FacturaAbierta[], total: number): string {
  const lineas = [...vencidas]
    .sort((a, b) => a.txn.date.getTime() - b.txn.date.getTime())
    .map((a) => `• ${a.numero} del ${fmtDate.format(a.txn.date)} por ${fmt.format(a.importe)}`);
  return [
    `Hola, ¿cómo están? Les escribimos de 2 Datos y Mercadeo por la cuenta de ${nombre}.`,
    "",
    "Según nuestros registros, estas facturas siguen pendientes de pago:",
    ...lineas,
    "",
    `Total: ${fmt.format(total)}`,
    "",
    "¿Nos confirman la fecha de pago? Si alguna ya la abonaron, les pedimos el comprobante de la transferencia y los certificados de retención. ¡Gracias!",
  ].join("\n");
}
