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

export function toSuggestionView(match: Match, txns: Txn[]): SuggestionView {
  const payments = txns.filter((t) => PAYMENT_SOURCES.has(t.source)).map(sideItem);
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
