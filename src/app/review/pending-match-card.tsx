"use client";

import { useTransition } from "react";
import type { matches, transactions } from "@/db/schema";
import { resolveMatchAction } from "./actions";

const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });
const fmtDate = new Intl.DateTimeFormat("es-AR", { dateStyle: "short" });

const SOURCE_LABELS: Record<string, string> = {
  bank: "Banco",
  card: "Tarjeta",
  afip_issued: "AFIP emitida",
  afip_received: "AFIP recibida",
  ticket: "Ticket (WhatsApp)",
};

type Match = typeof matches.$inferSelect;
type Txn = typeof transactions.$inferSelect;

export function PendingMatchCard({ match, transactions }: { match: Match; transactions: Txn[] }) {
  const [pending, startTransition] = useTransition();

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs text-amber-700">
          Confianza: {match.confidence}% · {match.note}
        </span>
        <div className="flex gap-2">
          <button
            disabled={pending}
            onClick={() => startTransition(() => resolveMatchAction(match.id, "confirmed"))}
            className="rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            Confirmar
          </button>
          <button
            disabled={pending}
            onClick={() => startTransition(() => resolveMatchAction(match.id, "rejected"))}
            className="rounded bg-slate-200 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-300 disabled:opacity-50"
          >
            Rechazar
          </button>
        </div>
      </div>
      <div className="space-y-1">
        {transactions.map((t) => (
          <div key={t.id} className="flex justify-between text-xs text-slate-700">
            <span>
              {SOURCE_LABELS[t.source] ?? t.source} · {fmtDate.format(t.date)} · {t.description}
            </span>
            <span className={Number(t.amount) < 0 ? "text-red-600" : "text-emerald-600"}>
              {fmt.format(Number(t.amount))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
