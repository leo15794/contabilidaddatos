"use client";

import { useState, useTransition } from "react";
import type { transactions } from "@/db/schema";
import { categorizeTransactionsAction, uncategorizeTransactionsAction, updateTransactionAmountAction } from "./actions";
import { Button, Amount } from "@/components/ui";
import { IconAlertTriangle } from "@/components/icons";

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
                  <EditableAmount transactionId={txn.id} amount={Number(txn.amount)} batchId={batchId} />
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

/**
 * Importe con edición a mano — pensado para comprobantes AFIP tipo C
 * (Factura/Recibo/NC de monotributistas) que quedan en $0 porque AFIP no
 * manda ese dato en el CSV, no hay nada que el parser pueda leer. Si el
 * importe es $0 se marca con un aviso para que salte a la vista sin tener
 * que ir fila por fila buscando cuáles faltan cargar.
 */
function EditableAmount({
  transactionId,
  amount,
  batchId,
}: {
  transactionId: number;
  amount: number;
  batchId: number;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(Math.abs(amount)));
  const [pending, startTransition] = useTransition();

  function save() {
    const parsed = Number(value.replace(",", "."));
    if (!Number.isFinite(parsed) || parsed < 0) return;
    startTransition(async () => {
      await updateTransactionAmountAction(transactionId, parsed, batchId);
      setEditing(false);
    });
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          step="0.01"
          min="0"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") setEditing(false);
          }}
          className="w-28 rounded-lg border border-indigo-300 px-2 py-1 text-sm tabular-nums outline-none focus:ring-2 focus:ring-indigo-100"
        />
        <button
          type="button"
          disabled={pending}
          onClick={save}
          className="rounded-lg bg-indigo-600 px-2 py-1 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          Guardar
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => setEditing(false)}
          className="rounded-lg px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
        >
          Cancelar
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Amount value={amount} />
      {amount === 0 && (
        <span
          className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
          title="Este comprobante llegó en $0 — probablemente la fuente original no trae el importe."
        >
          <IconAlertTriangle width={10} height={10} />
          revisar
        </span>
      )}
      <button
        type="button"
        onClick={() => {
          setValue(String(Math.abs(amount)));
          setEditing(true);
        }}
        className="text-xs font-medium text-indigo-600 hover:text-indigo-800"
      >
        Editar
      </button>
    </div>
  );
}
