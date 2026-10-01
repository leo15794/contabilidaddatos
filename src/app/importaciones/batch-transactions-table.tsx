"use client";

import { useState, useTransition } from "react";
import type { transactions } from "@/db/schema";
import { categorizeTransactionsAction, uncategorizeTransactionsAction } from "./actions";
import { Button, Amount } from "@/components/ui";

const fmtDate = new Intl.DateTimeFormat("es-AR", { dateStyle: "short" });

type Txn = typeof transactions.$inferSelect;
type Row = { txn: Txn; matchStatus: string | null };

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  auto: { bg: "bg-sky-100", text: "text-sky-800", label: "Conciliado (automático)" },
  confirmed: { bg: "bg-emerald-100", text: "text-emerald-800", label: "Conciliado (confirmado)" },
  manual: { bg: "bg-indigo-100", text: "text-indigo-800", label: "Conciliado (manual)" },
  pending: { bg: "bg-amber-100", text: "text-amber-800", label: "Pendiente de revisar" },
};
const NONE_STYLE = { bg: "bg-slate-100", text: "text-slate-600", label: "Sin conciliar" };
const CATEGORY_STYLE = { bg: "bg-violet-100", text: "text-violet-800" };

// Categorías frecuentes para que no haya que tipearlas siempre — es una
// sugerencia nomás, el input acepta cualquier texto.
const CATEGORY_PRESETS = [
  "Gastos operativos",
  "Impuestos y comisiones bancarias",
  "Intereses y gastos financieros",
];

export function BatchTransactionsTable({
  batchId,
  batchAccountRef,
  rows,
}: {
  batchId: number;
  batchAccountRef: string | null;
  rows: Row[];
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [category, setCategory] = useState(CATEGORY_PRESETS[0]);
  const [pending, startTransition] = useTransition();

  const allSelected = rows.length > 0 && selected.size === rows.length;

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.txn.id)));
  }

  function applyCategory() {
    const ids = Array.from(selected);
    startTransition(async () => {
      await categorizeTransactionsAction(ids, category, batchId);
      setSelected(new Set());
    });
  }

  function removeCategory(ids: number[]) {
    startTransition(async () => {
      await uncategorizeTransactionsAction(ids, batchId);
      setSelected(new Set());
    });
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50/60 px-5 py-3">
        <span className="text-xs text-slate-500">
          {selected.size > 0 ? `${selected.size} seleccionados` : "Seleccioná movimientos para categorizar"}
        </span>
        <input
          list="category-presets"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="Gastos operativos"
          className="w-56 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
        />
        <datalist id="category-presets">
          {CATEGORY_PRESETS.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <Button size="sm" disabled={selected.size === 0 || pending} onClick={applyCategory}>
          Marcar como categoría (no necesita conciliación)
        </Button>
        {selected.size > 0 && (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => removeCategory(Array.from(selected))}>
            Quitar categoría a los seleccionados
          </Button>
        )}
      </div>

      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-slate-400">
          <tr>
            <th className="px-5 py-2.5 font-medium">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-indigo-600" />
            </th>
            <th className="px-5 py-2.5 font-medium">Fecha</th>
            <th className="px-5 py-2.5 font-medium">Descripción</th>
            <th className="px-5 py-2.5 font-medium">Importe</th>
            <th className="px-5 py-2.5 font-medium">Estado</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ txn, matchStatus }) => {
            const style = (matchStatus && STATUS_STYLES[matchStatus]) || NONE_STYLE;
            return (
              <tr key={txn.id} className="border-t border-slate-100 hover:bg-slate-50/80">
                <td className="px-5 py-3">
                  <input
                    type="checkbox"
                    checked={selected.has(txn.id)}
                    onChange={() => toggle(txn.id)}
                    className="accent-indigo-600"
                  />
                </td>
                <td className="whitespace-nowrap px-5 py-3 text-slate-500">{fmtDate.format(txn.date)}</td>
                <td className="px-5 py-3 text-slate-700">
                  {txn.description}
                  {txn.accountRef && txn.accountRef !== batchAccountRef && (
                    <span className="ml-1.5 text-xs text-slate-400">({txn.accountRef})</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-5 py-3">
                  <Amount value={Number(txn.amount)} />
                </td>
                <td className="whitespace-nowrap px-5 py-3">
                  {txn.category ? (
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${CATEGORY_STYLE.bg} ${CATEGORY_STYLE.text}`}
                    >
                      {txn.category}
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => removeCategory([txn.id])}
                        className="text-violet-500 hover:text-violet-800"
                        title="Quitar categoría"
                      >
                        ×
                      </button>
                    </span>
                  ) : (
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${style.bg} ${style.text}`}
                    >
                      {style.label}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
