"use client";

import { useState, useTransition } from "react";
import type { transactions } from "@/db/schema";
import { createManualMatchAction } from "./actions";

const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });
const fmtDate = new Intl.DateTimeFormat("es-AR", { dateStyle: "short" });

const SOURCE_LABELS: Record<string, string> = {
  bank: "Banco",
  card: "Tarjeta",
  afip_issued: "AFIP emitida",
  afip_received: "AFIP recibida",
  ticket: "Ticket (WhatsApp)",
};

type Txn = typeof transactions.$inferSelect;

export function UnmatchedList({ transactions }: { transactions: Txn[] }) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [pending, startTransition] = useTransition();

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (transactions.length === 0) {
    return <p className="text-sm text-slate-500">Todo lo demás está conciliado o en revisión.</p>;
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs text-slate-500">{selected.size} seleccionados</span>
        <button
          disabled={selected.size < 2 || pending}
          onClick={() =>
            startTransition(async () => {
              await createManualMatchAction(Array.from(selected));
              setSelected(new Set());
            })
          }
          className="rounded bg-slate-900 px-2 py-1 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          Unir seleccionados
        </button>
      </div>
      <div className="max-h-96 overflow-y-auto rounded-lg border border-slate-200 bg-white">
        {transactions.map((t) => (
          <label
            key={t.id}
            className="flex cursor-pointer items-center gap-3 border-b border-slate-100 px-3 py-2 text-xs last:border-b-0 hover:bg-slate-50"
          >
            <input
              type="checkbox"
              checked={selected.has(t.id)}
              onChange={() => toggle(t.id)}
            />
            <span className="w-24 shrink-0 text-slate-500">
              {SOURCE_LABELS[t.source] ?? t.source}
            </span>
            <span className="w-20 shrink-0 text-slate-500">{fmtDate.format(t.date)}</span>
            <span className="flex-1 truncate text-slate-700">{t.description}</span>
            <span className={Number(t.amount) < 0 ? "text-red-600" : "text-emerald-600"}>
              {fmt.format(Number(t.amount))}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
