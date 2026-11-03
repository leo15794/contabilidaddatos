import { groupOf } from "@/lib/unmatched-groups";
import { netAmount } from "@/lib/amounts";
import type { matches, transactions } from "@/db/schema";

type Match = typeof matches.$inferSelect;
type Txn = typeof transactions.$inferSelect;

export type ResolvedMatch = { match: Match; transactions: Txn[] };

export type MatchGroupKind = "proveedor" | "cliente" | "otro";

export type MatchGroup = {
  key: string;
  label: string;
  cuit: string | null;
  kind: MatchGroupKind;
  count: number;
  /** Lo facturado (neto de notas de crédito); sin comprobantes, lo pagado. */
  total: number;
  last: Date;
  matches: ResolvedMatch[];
};

const PAYMENT_SOURCES = new Set(["bank", "card", "cash", "ticket", "retention"]);

/**
 * A qué grupo va un cruce: al proveedor o cliente de su comprobante de AFIP
 * (por CUIT, como en "Sin conciliar"). Los cruces sin comprobante, como el
 * pago de un resumen de tarjeta, van al grupo de su primer movimiento.
 */
export function matchGroupOf(txns: Txn[]): { key: string; label: string; cuit: string | null; kind: MatchGroupKind } {
  const doc = txns.find((t) => t.source === "afip_received") ?? txns.find((t) => t.source === "afip_issued");
  if (doc) return { ...groupOf(doc), kind: doc.source === "afip_received" ? "proveedor" : "cliente" };
  const first = [...txns].sort((a, b) => a.date.getTime() - b.date.getTime())[0];
  if (!first) return { key: "vacio", label: "(sin movimientos)", cuit: null, kind: "otro" };
  return { ...groupOf(first), kind: "otro" };
}

export function matchTotal(txns: Txn[]): number {
  const docs = txns.filter((t) => !PAYMENT_SOURCES.has(t.source));
  if (docs.length > 0) return docs.reduce((acc, t) => acc + netAmount(t.source, t.amount), 0);
  return txns.reduce((acc, t) => acc + Math.abs(Number(t.amount)), 0);
}

export function matchDate(txns: Txn[]): Date {
  return txns.reduce((max, t) => (t.date > max ? t.date : max), new Date(0));
}

/** Agrupa los cruces; los grupos van por plata (el más grande primero) y adentro, el más reciente primero. */
export function groupMatches(rows: ResolvedMatch[]): MatchGroup[] {
  const groups = new Map<string, MatchGroup>();
  for (const row of rows) {
    const g = matchGroupOf(row.transactions);
    const total = matchTotal(row.transactions);
    const date = matchDate(row.transactions);
    const existing = groups.get(g.key);
    if (existing) {
      existing.count++;
      existing.total += total;
      if (date > existing.last) existing.last = date;
      existing.matches.push(row);
      if (g.label.length > existing.label.length) existing.label = g.label;
    } else {
      groups.set(g.key, { ...g, count: 1, total, last: date, matches: [row] });
    }
  }
  for (const g of groups.values()) {
    g.matches.sort((a, b) => matchDate(b.transactions).getTime() - matchDate(a.transactions).getTime());
  }
  return [...groups.values()].sort((a, b) => b.total - a.total);
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/**
 * Filtra los cruces por texto (cada palabra tiene que aparecer en algún
 * movimiento o en la nota del cruce) y/o por importe: el de algún movimiento
 * o el total del cruce, con el margen pedido.
 */
export function filterMatches(
  rows: ResolvedMatch[],
  { text, amount, margin = 0 }: { text?: string; amount?: number; margin?: number },
): ResolvedMatch[] {
  const words = fold(text ?? "").split(/\s+/).filter(Boolean);
  const delta = amount ? Math.max(1, amount * margin) : 0;
  return rows.filter(({ match, transactions: txns }) => {
    if (words.length > 0) {
      const haystack = fold(
        [match.note ?? "", ...txns.map((t) => `${t.description} ${t.counterparty ?? ""} ${t.accountRef ?? ""}`)].join(" "),
      );
      if (!words.every((w) => haystack.includes(w))) return false;
    }
    if (amount) {
      const near = (n: number) => Math.abs(Math.abs(n) - amount) <= delta;
      if (!txns.some((t) => near(Number(t.amount))) && !near(matchTotal(txns))) return false;
    }
    return true;
  });
}
