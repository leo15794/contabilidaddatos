import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * Datos de la pantalla de Inicio que no están en getDashboardSummary: la
 * antigüedad de lo que te deben y lo que debés, los clientes que más deben,
 * el % conciliado mes a mes y qué meses tiene cargados cada fuente.
 *
 * "Abierta" = factura sin ningún cruce (que no esté rechazado) y sin categoría,
 * salvo "Pendientes de pago", que justamente es deuda abierta.
 */

export type Aging = { d0_30: number; d31_90: number; d90: number; total: number; count: number };
export type Debtor = Aging & { cuit: string; name: string };
export type MonthPct = { month: string; pct: number | null };
export type Coverage = { month: string; bank: number; card: number; afip: number; retention: number };

const OPEN_DOC = sql`
  not exists (select 1 from match_items mi join matches m on m.id = mi.match_id
              where mi.transaction_id = t.id and m.status <> 'rejected')
  and (t.category is null or t.category = '' or t.category = 'Pendientes de pago')`;

const RESOLVED = sql`exists (select 1 from match_items mi join matches m on m.id = mi.match_id
                            where mi.transaction_id = t.id and m.status in ('auto','confirmed','manual'))`;

const toNum = (v: unknown) => Number(v ?? 0);

/** Lo que te deben (emitidas) o lo que debés (recibidas), por tramos de días desde la factura. */
export async function getAging(source: "afip_issued" | "afip_received"): Promise<Aging> {
  // Las recibidas se guardan en negativo (egreso): se da vuelta para que la deuda sume positiva.
  const amount = source === "afip_issued" ? sql`t.amount` : sql`-t.amount`;
  const [row] = await db.execute<Record<string, unknown>>(sql`
    select
      coalesce(sum(${amount}) filter (where current_date - t.date::date <= 30), 0) as d0_30,
      coalesce(sum(${amount}) filter (where current_date - t.date::date between 31 and 90), 0) as d31_90,
      coalesce(sum(${amount}) filter (where current_date - t.date::date > 90), 0) as d90,
      coalesce(sum(${amount}), 0) as total,
      count(*) as count
    from transactions t
    where t.source = ${source} and ${amount} > 0 and ${OPEN_DOC}`);
  return {
    d0_30: toNum(row?.d0_30),
    d31_90: toNum(row?.d31_90),
    d90: toNum(row?.d90),
    total: toNum(row?.total),
    count: toNum(row?.count),
  };
}

/** Clientes con más facturas emitidas sin cobrar, agrupados por CUIT. */
export async function getTopDebtors(limit = 5): Promise<Debtor[]> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    select
      split_part(regexp_replace(t.counterparty, '\\.0', '', 'g'), ' - ', 1) as cuit,
      -- El nombre es todo lo que sigue al primer " - " (algunos, como las UTE, llevan otro guion adentro).
      max(substr(t.counterparty, position(' - ' in t.counterparty) + 3)) as name,
      coalesce(sum(t.amount) filter (where current_date - t.date::date <= 30), 0) as d0_30,
      coalesce(sum(t.amount) filter (where current_date - t.date::date between 31 and 90), 0) as d31_90,
      coalesce(sum(t.amount) filter (where current_date - t.date::date > 90), 0) as d90,
      sum(t.amount) as total,
      count(*) as count
    from transactions t
    where t.source = 'afip_issued' and t.amount > 0 and ${OPEN_DOC}
    group by 1
    order by total desc
    limit ${limit}`);
  return rows.map((r) => ({
    cuit: String(r.cuit ?? ""),
    name: String(r.name ?? r.cuit ?? ""),
    d0_30: toNum(r.d0_30),
    d31_90: toNum(r.d31_90),
    d90: toNum(r.d90),
    total: toNum(r.total),
    count: toNum(r.count),
  }));
}

function lastMonths(n: number, skip = 0): string[] {
  const now = new Date();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - skip - (n - 1 - i), 1));
    return d.toISOString().slice(0, 7);
  });
}

/**
 * % conciliado de cada uno de los últimos meses, con la misma cuenta que el
 * total del tablero (lo categorizado no cuenta). `skip` saltea los meses más
 * recientes: el mes en curso todavía no tiene sus archivos y saldría en 0%.
 */
export async function getMonthlyConciliation(n = 6, skip = 0): Promise<MonthPct[]> {
  const months = lastMonths(n, skip);
  const rows = await db.execute<Record<string, unknown>>(sql`
    select to_char(date_trunc('month', t.date), 'YYYY-MM') as month,
      count(*) filter (where ${RESOLVED}) as resolved,
      count(*) - count(*) filter (where t.category is not null and t.category <> '') as base
    from transactions t
    where t.date >= ${months[0] + "-01"}::date and t.date < (${months[months.length - 1] + "-01"}::date + interval '1 month')
    group by 1`);
  const byMonth = new Map(rows.map((r) => [String(r.month), r]));
  return months.map((month) => {
    const r = byMonth.get(month);
    const base = toNum(r?.base);
    return { month, pct: base > 0 ? Math.round((toNum(r?.resolved) / base) * 100) : null };
  });
}

/** Cuántos movimientos tiene cada fuente en cada uno de los últimos meses: un mes en 0 es un archivo que falta cargar. */
export async function getCoverage(n = 6): Promise<Coverage[]> {
  const months = lastMonths(n);
  const rows = await db.execute<Record<string, unknown>>(sql`
    select to_char(date_trunc('month', t.date), 'YYYY-MM') as month,
      count(*) filter (where t.source = 'bank') as bank,
      count(*) filter (where t.source = 'card') as card,
      count(*) filter (where t.source in ('afip_issued','afip_received')) as afip,
      count(*) filter (where t.source = 'retention') as retention
    from transactions t
    where t.date >= ${months[0] + "-01"}::date
    group by 1`);
  const byMonth = new Map(rows.map((r) => [String(r.month), r]));
  return months.map((month) => {
    const r = byMonth.get(month);
    return { month, bank: toNum(r?.bank), card: toNum(r?.card), afip: toNum(r?.afip), retention: toNum(r?.retention) };
  });
}
