import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { partners, partnerBalances, transactions } from "@/db/schema";

export type Partner = typeof partners.$inferSelect;
export type PartnerBalance = typeof partnerBalances.$inferSelect;

/** "Patricio Moloy" -> "PATRICIO MOLOY" — para que no importen espacios de más ni mayúsculas al comparar contra el nombre del titular que viene impreso en el resumen de tarjeta. */
export function normalizePartnerName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toUpperCase();
}

/** Primer día del mes de `date` (hora local), sin horas — para usar como clave de `partner_balances.month` y como límite de rango. */
export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function addMonths(date: Date, n: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + n, 1);
}

/** "2026-10" <-> Date del primer día de ese mes — formato que usan los inputs `type="month"`. */
export function monthKeyToDate(monthKey: string): Date {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, 1);
}

export function dateToMonthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Condición SQL: "esta transacción es un gasto de tarjeta del socio con este
 * nombre". Hoy solo mira `raw->>'cardholder'` (el titular de la tarjeta
 * adicional, ver `buildRowsFromExtraction`) — cuando el agente de WhatsApp
 * para tickets esté conectado, acá se agrega un `OR` comparando el teléfono
 * del socio contra el remitente del ticket, para que la misma función sirva
 * para las dos fuentes sin tocar nada más.
 */
function belongsToPartner(partnerName: string) {
  const normalized = normalizePartnerName(partnerName);
  return sql`upper(trim(${transactions.raw}->>'cardholder')) = ${normalized}`;
}

export async function listPartners(): Promise<Partner[]> {
  return db.select().from(partners).orderBy(partners.name);
}

export async function getPartner(id: number): Promise<Partner | null> {
  const [p] = await db.select().from(partners).where(eq(partners.id, id)).limit(1);
  return p ?? null;
}

export async function createPartner(name: string, phone: string | null): Promise<Partner> {
  const [p] = await db
    .insert(partners)
    .values({ name: name.trim(), phone: phone?.trim() || null })
    .returning();
  return p;
}

export async function deletePartner(id: number): Promise<void> {
  await db.delete(partners).where(eq(partners.id, id));
}

/** Gasto total (valor absoluto) atribuido a un socio en un rango de fechas [from, to). Hoy solo tarjeta — ver `belongsToPartner`. */
export async function getPartnerSpend(
  partnerName: string,
  from: Date,
  to: Date,
): Promise<{ total: number; count: number }> {
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(abs(${transactions.amount})), 0)`,
      count: sql<number>`count(*)::int`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.source, "card"),
        belongsToPartner(partnerName),
        sql`${transactions.date} >= ${from} and ${transactions.date} < ${to}`,
      ),
    );
  return { total: Number(row?.total ?? 0), count: row?.count ?? 0 };
}

export async function getPartnerBalance(partnerId: number, month: Date): Promise<PartnerBalance | null> {
  const [row] = await db
    .select()
    .from(partnerBalances)
    .where(and(eq(partnerBalances.partnerId, partnerId), eq(partnerBalances.month, startOfMonth(month))))
    .limit(1);
  return row ?? null;
}

/** Carga (o actualiza) el saldo asignado a un socio para un mes puntual. */
export async function setPartnerBalance(partnerId: number, month: Date, amount: number): Promise<void> {
  const monthStart = startOfMonth(month);
  await db
    .insert(partnerBalances)
    .values({ partnerId, month: monthStart, amount: amount.toFixed(2) })
    .onConflictDoUpdate({
      target: [partnerBalances.partnerId, partnerBalances.month],
      set: { amount: amount.toFixed(2), updatedAt: new Date() },
    });
}

/** Lista de movimientos de tarjeta atribuidos a un socio en un rango de fechas, más recientes primero. */
export async function getPartnerTransactions(partnerName: string, from: Date, to: Date) {
  return db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.source, "card"),
        belongsToPartner(partnerName),
        sql`${transactions.date} >= ${from} and ${transactions.date} < ${to}`,
      ),
    )
    .orderBy(desc(transactions.date));
}

/** Gasto mes a mes de un socio, para el gráfico de evolución (últimos `monthsBack` meses, incluyendo el actual). */
export async function getPartnerMonthlyHistory(partnerName: string, monthsBack = 6) {
  const now = new Date();
  const since = addMonths(startOfMonth(now), -(monthsBack - 1));

  const rows = await db
    .select({
      month: sql<string>`to_char(date_trunc('month', ${transactions.date}), 'YYYY-MM')`,
      total: sql<string>`sum(abs(${transactions.amount}))`,
    })
    .from(transactions)
    .where(
      and(eq(transactions.source, "card"), belongsToPartner(partnerName), sql`${transactions.date} >= ${since}`),
    )
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  const totalsByMonth = new Map(rows.map((r) => [r.month, Number(r.total)]));

  // Devuelve siempre los `monthsBack` meses completos, en orden, con 0 en los
  // que no tuvieron gasto — así el gráfico no "salta" meses sin datos.
  const result: { month: string; total: number }[] = [];
  for (let i = 0; i < monthsBack; i++) {
    const d = addMonths(since, i);
    const key = dateToMonthKey(d);
    result.push({ month: key, total: totalsByMonth.get(key) ?? 0 });
  }
  return result;
}

export type PartnerSummary = {
  partner: Partner;
  spentThisMonth: number;
  balanceThisMonth: number | null;
  remaining: number | null;
};

/** Para /socios: cada socio con su gasto del mes actual y cómo viene de saldo. */
export async function getPartnersSummary(): Promise<PartnerSummary[]> {
  const all = await listPartners();
  const now = new Date();
  const from = startOfMonth(now);
  const to = addMonths(from, 1);

  const result: PartnerSummary[] = [];
  for (const partner of all) {
    const { total } = await getPartnerSpend(partner.name, from, to);
    const balance = await getPartnerBalance(partner.id, from);
    const balanceAmount = balance ? Number(balance.amount) : null;
    result.push({
      partner,
      spentThisMonth: total,
      balanceThisMonth: balanceAmount,
      remaining: balanceAmount === null ? null : balanceAmount - total,
    });
  }
  return result;
}
