import type { matches, transactions } from "@/db/schema";
import { isCreditNote, netAmount } from "@/lib/amounts";
import { comprobanteLegible } from "@/lib/cuenta-corriente-libro";

type Match = typeof matches.$inferSelect;
type Txn = typeof transactions.$inferSelect;

/** Un renglón de un lado de la sugerencia, ya armado para mostrar (el cliente no necesita la fila cruda). */
export type SideItem = {
  id: number;
  source: string;
  title: string;
  subtitle: string;
  date: string;
  /** Importe "en sentido del cruce": pagos y retenciones positivos; facturas positivas y notas de crédito negativas. */
  amount: number;
};

export type SuggestionView = {
  id: number;
  confidence: number;
  note: string | null;
  kind: "tarjeta" | "banco" | "efectivo" | "otro";
  multi: boolean;
  payments: SideItem[];
  documents: SideItem[];
  paymentsTotal: number;
  documentsTotal: number;
  diff: number;
};

// El movimiento de plata va a la izquierda (como el renglón del extracto en Xero) y el comprobante a la derecha.
const PAYMENT_SOURCES = new Set(["bank", "card", "cash", "ticket", "retention"]);

const fmtDate = new Intl.DateTimeFormat("es-AR", {
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "UTC",
});

function counterpartyName(t: Txn): string {
  const cp = t.counterparty ?? "";
  const i = cp.indexOf(" - ");
  return i >= 0 ? cp.slice(i + 3) : cp || t.description;
}

function sideItem(t: Txn): SideItem {
  const date = fmtDate.format(t.date);
  if (t.source === "afip_issued" || t.source === "afip_received") {
    const { tipo, numero } = comprobanteLegible(t.description);
    const cuit = (t.counterparty ?? "").split(" - ")[0].replace(/\.0$/, "");
    return {
      id: t.id,
      source: t.source,
      title: counterpartyName(t),
      subtitle: `${tipo} ${numero}${cuit ? ` · CUIT ${cuit}` : ""}`,
      date,
      amount: netAmount(t.source, t.amount),
    };
  }
  const holder = t.accountRef?.includes("·") ? t.accountRef.split("·").pop()?.trim() : t.accountRef;
  const subtitle =
    t.source === "card"
      ? `Tarjeta${holder ? ` · ${holder}` : ""}`
      : t.source === "retention"
        ? "Certificado de retención"
        : t.source === "cash"
          ? `Efectivo${holder ? ` · ${holder}` : ""}`
          : `Banco${t.accountRef ? ` · ${t.accountRef}` : ""}`;
  // Una retención anulada viene en negativo y resta del cobro.
  const amount = t.source === "retention" ? Number(t.amount) : Math.abs(Number(t.amount));
  return { id: t.id, source: t.source, title: t.description, subtitle, date, amount };
}

function installments(t: Txn): { count: number; key: string } | null {
  if (t.source !== "card" || !t.raw || typeof t.raw !== "object") return null;
  const raw = t.raw as Record<string, unknown>;
  const m = /^\s*\d+\s*\/\s*(\d+)\s*$/.exec(String(raw.cuotas ?? ""));
  const count = m ? Number(m[1]) : 0;
  if (count < 2) return null;
  return { count, key: `${raw.cardNumber ?? ""}|${raw.comprobante || t.description}|${t.date.toISOString().slice(0, 10)}|${count}` };
}

/**
 * Una compra en cuotas trae una fila por cuota en cada resumen mensual, y la
 * factura es por el total: se muestra como un solo pago por cuota x cantidad.
 * Sumando solo las cuotas ya cargadas, la silla de 9 cuotas de $50.700,57
 * (3 cargadas) aparecía con $346.000 de diferencia contra su factura.
 */
function paymentItems(txns: Txn[]): SideItem[] {
  const groups = new Map<string, { rows: Txn[]; count: number }>();
  for (const t of txns) {
    const inst = installments(t);
    if (!inst) continue;
    const g = groups.get(inst.key) ?? { rows: [], count: inst.count };
    g.rows.push(t);
    groups.set(inst.key, g);
  }

  const items: SideItem[] = [];
  for (const t of txns) {
    const inst = installments(t);
    if (!inst) {
      items.push(sideItem(t));
      continue;
    }
    const g = groups.get(inst.key)!;
    if (g.rows[0] !== t) continue; // la compra ya se mostró con su primera cuota
    const cuota = g.rows.reduce((acc, r) => acc + Math.abs(Number(r.amount)), 0) / g.rows.length;
    const loaded = new Set(g.rows.map((r) => String((r.raw as Record<string, unknown>).cuotas).split("/")[0].trim())).size;
    const item = sideItem(t);
    items.push({
      ...item,
      subtitle: `${item.subtitle} · ${g.count} cuotas de ${cuota.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${loaded} de ${g.count} en los resúmenes cargados)`,
      amount: Math.round(cuota * g.count * 100) / 100,
    });
  }
  return items;
}

export function toSuggestionView(match: Match, txns: Txn[]): SuggestionView {
  const payments = paymentItems(txns.filter((t) => PAYMENT_SOURCES.has(t.source)));
  const documents = txns
    .filter((t) => !PAYMENT_SOURCES.has(t.source))
    .map(sideItem)
    .sort((a, b) => b.amount - a.amount);
  const paymentsTotal = payments.reduce((acc, p) => acc + p.amount, 0);
  const documentsTotal = documents.reduce((acc, d) => acc + d.amount, 0);
  const sources = new Set(txns.map((t) => t.source));
  const kind = sources.has("card") ? "tarjeta" : sources.has("bank") ? "banco" : sources.has("cash") ? "efectivo" : "otro";
  return {
    id: match.id,
    confidence: match.confidence,
    note: match.note,
    kind,
    multi: documents.filter((d) => !isCreditNote(d.subtitle)).length > 1 || payments.length > 1,
    payments,
    documents,
    paymentsTotal,
    documentsTotal,
    diff: Math.round((paymentsTotal - documentsTotal) * 100) / 100,
  };
}
