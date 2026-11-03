"use client";

import { useState, useTransition, type FormEvent } from "react";
import type { ManualSearchRow } from "@/lib/queries";
import { netAmount } from "@/lib/amounts";
import { Button, SourceBadge, Amount } from "@/components/ui";
import { createManualMatchAction, searchManualAction } from "./actions";

const fmtDate = new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeZone: "UTC" });
const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });

// El movimiento de plata de un lado, el comprobante del otro (igual que en Revisar sugerencias).
const PAYMENT_SOURCES = new Set(["bank", "card", "cash", "ticket", "retention"]);

const MARGINS = [
  { value: 0, label: "Exacto" },
  { value: 0.01, label: "± 1 %" },
  { value: 0.05, label: "± 5 %" },
  { value: 0.1, label: "± 10 %" },
];

/**
 * Buscar facturas y pagos sin conciliar (de cualquier fuente) e ir juntándolos
 * en una bandeja: se puede buscar la factura, después el pago, y unirlos aunque
 * no aparezcan en la misma búsqueda.
 */
export function ManualMatchSearch({ readOnly = false }: { readOnly?: boolean }) {
  const [text, setText] = useState("");
  const [amount, setAmount] = useState("");
  const [margin, setMargin] = useState(0);
  const [results, setResults] = useState<ManualSearchRow[] | null>(null);
  const [selected, setSelected] = useState<Map<number, ManualSearchRow>>(new Map());
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [searching, startSearch] = useTransition();
  const [joining, startJoin] = useTransition();

  function search(e?: FormEvent) {
    e?.preventDefault();
    if (!text.trim() && !amount.trim()) return;
    startSearch(async () => setResults(await searchManualAction({ text, amount, margin })));
  }

  function toggle(row: ManualSearchRow) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(row.id)) next.delete(row.id);
      else next.set(row.id, row);
      return next;
    });
  }

  function join() {
    startJoin(async () => {
      const result = await createManualMatchAction([...selected.keys()]);
      if (result.error) {
        setMessage({ error: true, text: result.error });
        return;
      }
      setMessage({ error: false, text: `Listo: ${selected.size} movimientos unidos.` });
      // Se sacan de la lista acá: volver a buscar en la misma transición traía la respuesta vieja.
      setResults((prev) => prev?.filter((r) => !selected.has(r.id)) ?? null);
      setSelected(new Map());
    });
  }

  const picked = [...selected.values()];
  const payments = picked.filter((r) => PAYMENT_SOURCES.has(r.source)).reduce((acc, r) => acc + Math.abs(r.amount), 0);
  const documents = picked.filter((r) => !PAYMENT_SOURCES.has(r.source)).reduce((acc, r) => acc + netAmount(r.source, r.amount), 0);
  const diff = Math.round((payments - documents) * 100) / 100;

  return (
    <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-200">
      <form onSubmit={search} className="flex flex-wrap items-end gap-2">
        <label className="min-w-[200px] flex-[2] text-[11.5px] font-medium text-slate-500">
          Proveedor, CUIT, comprobante o descripción
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Ej. Córdoba, 20425563506, 1-19"
            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-[13px] text-slate-800 outline-none focus:border-indigo-400"
          />
        </label>
        <label className="min-w-[140px] flex-1 text-[11.5px] font-medium text-slate-500">
          Importe
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="Ej. 1.254.500"
            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-[13px] tabular-nums text-slate-800 outline-none focus:border-indigo-400"
          />
        </label>
        <label className="text-[11.5px] font-medium text-slate-500">
          Margen
          <select
            value={margin}
            onChange={(e) => setMargin(Number(e.target.value))}
            className="mt-1 block rounded-lg border border-slate-200 bg-white px-2 py-2 text-[13px] text-slate-800"
          >
            {MARGINS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" size="sm" className="py-2.5" disabled={searching || (!text.trim() && !amount.trim())}>
          {searching ? "Buscando…" : "Buscar"}
        </Button>
      </form>

      {results !== null && (
        <div className="mt-3">
          <p className="mb-1.5 text-[11.5px] text-slate-500">
            {results.length === 0
              ? "No hay nada sin conciliar con esos datos."
              : `${results.length}${results.length === 100 ? " (los 100 más parecidos)" : ""} resultado(s). Tildá los que van juntos; podés buscar de nuevo y se mantienen.`}
          </p>
          {results.length > 0 && (
            <div className="max-h-80 overflow-y-auto rounded-xl border border-slate-200">
              {results.map((r) => (
                <ResultRow
                  key={r.id}
                  row={r}
                  checked={selected.has(r.id)}
                  disabled={readOnly || r.inSuggestion}
                  onToggle={() => toggle(r)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {picked.length > 0 && (
        <div className="mt-4 rounded-xl bg-indigo-50/60 p-3 ring-1 ring-indigo-100">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[12.5px] font-semibold text-slate-800">Para unir · {picked.length}</p>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Map())}>
                Vaciar
              </Button>
              <Button size="sm" disabled={picked.length < 2 || joining} onClick={join}>
                {joining ? "Uniendo…" : "Unir seleccionados"}
              </Button>
            </div>
          </div>
          <div className="mt-2 overflow-hidden rounded-lg border border-indigo-100 bg-white">
            {picked.map((r) => (
              <ResultRow key={r.id} row={r} checked disabled={false} onToggle={() => toggle(r)} />
            ))}
          </div>
          <p className="mt-2 text-[12px] tabular-nums text-slate-600">
            Pagos {fmt.format(payments)} · Comprobantes {fmt.format(documents)} ·{" "}
            <span className={diff === 0 ? "font-semibold text-emerald-700" : "font-semibold text-amber-700"}>
              {diff === 0 ? "cierra justo" : `diferencia ${fmt.format(diff)}`}
            </span>
          </p>
        </div>
      )}

      {message && (
        <p className={`mt-2 text-[12px] ${message.error ? "text-red-600" : "text-emerald-700"}`}>{message.text}</p>
      )}
    </div>
  );
}

function ResultRow({
  row,
  checked,
  disabled,
  onToggle,
}: {
  row: ManualSearchRow;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      className={`flex items-center gap-3 border-b border-slate-100 px-3 py-2 text-xs last:border-b-0 ${
        disabled ? "opacity-60" : "cursor-pointer hover:bg-slate-50"
      }`}
    >
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} className="accent-indigo-600" />
      <span className="w-24 shrink-0">
        <SourceBadge source={row.source} />
      </span>
      <span className="w-16 shrink-0 text-slate-500">{fmtDate.format(new Date(row.date))}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-slate-700">{row.description}</span>
        {(row.category || row.inSuggestion || row.accountRef) && (
          <span className="block truncate text-[11px] text-slate-400">
            {[
              row.inSuggestion && <span key="s" className="font-medium text-amber-600">En Revisar sugerencias</span>,
              row.category && <span key="c" className="font-medium text-slate-500">{row.category}</span>,
              row.accountRef,
            ]
              .filter(Boolean)
              .flatMap((part, i) => (i === 0 ? [part] : [" · ", part]))}
          </span>
        )}
      </span>
      <Amount value={row.amount} />
    </label>
  );
}
