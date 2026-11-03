"use client";

import { useState, useTransition, type FormEvent } from "react";
import type { ManualSearchRow } from "@/lib/queries";
import { netAmount } from "@/lib/amounts";
import { Button, SourceBadge, Amount } from "@/components/ui";
import { createManualMatchAction, searchManualAction } from "./actions";

const fmtDate = new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeZone: "UTC" });
const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });
const fmtInput = new Intl.NumberFormat("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const MARGINS = [
  { value: 0, label: "Exacto" },
  { value: 0.01, label: "± 1 %" },
  { value: 0.05, label: "± 5 %" },
  { value: 0.1, label: "± 10 %" },
];

type Side = "comprobantes" | "pagos";
type Selection = Map<number, ManualSearchRow>;

/** Facturas suman y notas de crédito restan; los pagos, en valor absoluto (como en Revisar sugerencias). */
const docsTotal = (rows: ManualSearchRow[]) => rows.reduce((acc, r) => acc + netAmount(r.source, r.amount), 0);
const paysTotal = (rows: ManualSearchRow[]) => rows.reduce((acc, r) => acc + Math.abs(r.amount), 0);

/**
 * Conciliar a mano en dos pasos: de un lado se buscan y tildan las facturas
 * (comprobantes de AFIP), del otro los pagos (banco, tarjeta, efectivo,
 * retenciones). "Conciliar" pide confirmación mostrando las dos partes y la
 * diferencia, y recién con el OK crea el cruce.
 */
export function ManualMatchSearch({ readOnly = false }: { readOnly?: boolean }) {
  const [docs, setDocs] = useState<Selection>(new Map());
  const [pays, setPays] = useState<Selection>(new Map());
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const [joining, startJoin] = useTransition();

  const pickedDocs = [...docs.values()];
  const pickedPays = [...pays.values()];
  const docSum = docsTotal(pickedDocs);
  const paySum = paysTotal(pickedPays);
  const diff = Math.round((paySum - docSum) * 100) / 100;
  const count = pickedDocs.length + pickedPays.length;

  function conciliate() {
    const ids = [...docs.keys(), ...pays.keys()];
    startJoin(async () => {
      const result = await createManualMatchAction(ids);
      if (result.error) {
        setMessage({ error: true, text: result.error });
        setConfirming(false);
        return;
      }
      setMessage({
        error: false,
        text: `Listo: se conciliaron ${pickedDocs.length} comprobante(s) con ${pickedPays.length} pago(s).`,
      });
      setRemoved((prev) => new Set([...prev, ...ids]));
      setDocs(new Map());
      setPays(new Map());
      setConfirming(false);
    });
  }

  return (
    <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-200">
      <div className="grid gap-4 lg:grid-cols-2">
        <SearchPanel
          side="comprobantes"
          step={1}
          title="Facturas y notas de crédito"
          placeholder="Ej. Córdoba, 20425563506, 1-19"
          selected={docs}
          onChange={setDocs}
          removed={removed}
          readOnly={readOnly}
          suggestedAmount={pickedPays.length > 0 ? paySum : undefined}
          suggestedLabel="lo pagado"
        />
        <SearchPanel
          side="pagos"
          step={2}
          title="Pagos y cobros"
          placeholder="Ej. transferencia, VISA, MERPAGO"
          selected={pays}
          onChange={setPays}
          removed={removed}
          readOnly={readOnly}
          suggestedAmount={pickedDocs.length > 0 ? docSum : undefined}
          suggestedLabel="lo facturado"
        />
      </div>

      {count > 0 && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-indigo-50/60 px-4 py-3 ring-1 ring-indigo-100">
          <p className="text-[12.5px] tabular-nums text-slate-700">
            <b>{pickedDocs.length}</b> comprobante(s) {fmt.format(docSum)} · <b>{pickedPays.length}</b> pago(s){" "}
            {fmt.format(paySum)} ·{" "}
            <span className={diff === 0 ? "font-semibold text-emerald-700" : "font-semibold text-amber-700"}>
              {diff === 0 ? "cierra justo" : `diferencia ${fmt.format(diff)}`}
            </span>
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDocs(new Map());
                setPays(new Map());
              }}
            >
              Vaciar
            </Button>
            <Button size="sm" disabled={readOnly || count < 2} onClick={() => setConfirming(true)}>
              Conciliar
            </Button>
          </div>
        </div>
      )}

      {message && (
        <p className={`mt-2 text-[12px] ${message.error ? "text-red-600" : "text-emerald-700"}`}>{message.text}</p>
      )}

      {confirming && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
          onClick={() => !joining && setConfirming(false)}
        >
          <div className="w-full max-w-2xl rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 id="confirm-title" className="text-[16px] font-bold text-slate-900">
              ¿Cruzar {pickedDocs.length === 1 ? "esta factura" : `estas ${pickedDocs.length} facturas`}
              {pickedPays.length > 0 && (pickedPays.length === 1 ? " con este pago" : ` con estos ${pickedPays.length} pagos`)}?
            </h3>
            {pickedPays.length === 0 && (
              <p className="mt-1 text-[12.5px] text-amber-700">No elegiste ningún pago: se cruzan solo comprobantes entre sí.</p>
            )}
            {pickedDocs.length === 0 && (
              <p className="mt-1 text-[12.5px] text-amber-700">No elegiste ninguna factura: se cruzan solo pagos entre sí.</p>
            )}

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <ConfirmList title="Comprobantes" rows={pickedDocs} total={docSum} />
              <ConfirmList title="Pagos" rows={pickedPays} total={paySum} />
            </div>

            <p
              className={`mt-4 rounded-lg px-3 py-2 text-[13px] font-semibold tabular-nums ${
                diff === 0 ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"
              }`}
            >
              {diff === 0
                ? "Cierra justo, sin diferencia."
                : diff > 0
                  ? `Se pagó ${fmt.format(diff)} de más.`
                  : `Faltan ${fmt.format(-diff)} por pagar.`}
            </p>

            <div className="mt-5 flex justify-end gap-2">
              <Button variant="secondary" size="sm" disabled={joining} onClick={() => setConfirming(false)}>
                Cancelar
              </Button>
              <Button variant="success" size="sm" disabled={joining} onClick={conciliate}>
                {joining ? "Conciliando…" : "Sí, conciliar"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SearchPanel({
  side,
  step,
  title,
  placeholder,
  selected,
  onChange,
  removed,
  readOnly,
  suggestedAmount,
  suggestedLabel,
}: {
  side: Side;
  step: number;
  title: string;
  placeholder: string;
  selected: Selection;
  onChange: (next: Selection) => void;
  removed: Set<number>;
  readOnly: boolean;
  /** El total tildado del otro lado, para buscar con un clic lo que lo cierra. */
  suggestedAmount?: number;
  suggestedLabel: string;
}) {
  const [text, setText] = useState("");
  const [amount, setAmount] = useState("");
  const [margin, setMargin] = useState(0);
  const [results, setResults] = useState<ManualSearchRow[] | null>(null);
  const [searching, startSearch] = useTransition();

  function run(next: { text: string; amount: string; margin: number }) {
    if (!next.text.trim() && !next.amount.trim()) return;
    startSearch(async () => setResults(await searchManualAction({ ...next, side })));
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    run({ text, amount, margin });
  }

  function toggle(row: ManualSearchRow) {
    const next = new Map(selected);
    if (next.has(row.id)) next.delete(row.id);
    else next.set(row.id, row);
    onChange(next);
  }

  const visible = results?.filter((r) => !removed.has(r.id)) ?? null;
  // Lo tildado se sigue viendo arriba aunque una búsqueda nueva no lo traiga.
  const pinned = [...selected.values()].filter((r) => !visible?.some((v) => v.id === r.id));

  return (
    <section className="flex flex-col rounded-xl border border-slate-200 p-3">
      <p className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-slate-800">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-indigo-600 text-[11px] text-white">{step}</span>
        {title}
        {selected.size > 0 && <span className="text-[11.5px] font-medium text-indigo-600">· {selected.size} tildado(s)</span>}
      </p>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          aria-label={`Buscar ${title.toLowerCase()} por texto`}
          className="min-w-[140px] flex-[2] rounded-lg border border-slate-200 px-3 py-2 text-[13px] text-slate-800 outline-none focus:border-indigo-400"
        />
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          placeholder="Importe"
          aria-label={`Importe de ${title.toLowerCase()}`}
          className="w-28 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-[13px] tabular-nums text-slate-800 outline-none focus:border-indigo-400"
        />
        <select
          value={margin}
          onChange={(e) => setMargin(Number(e.target.value))}
          aria-label="Margen del importe"
          className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-[13px] text-slate-800"
        >
          {MARGINS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <Button type="submit" size="sm" className="py-2.5" disabled={searching || (!text.trim() && !amount.trim())}>
          {searching ? "Buscando…" : "Buscar"}
        </Button>
      </form>

      {suggestedAmount !== undefined && suggestedAmount > 0 && (
        <button
          type="button"
          onClick={() => {
            const value = fmtInput.format(suggestedAmount);
            const next = { text: "", amount: value, margin: margin || 0.05 };
            setText(next.text);
            setAmount(next.amount);
            setMargin(next.margin);
            run(next);
          }}
          className="mt-2 self-start text-[11.5px] font-medium text-indigo-600 hover:text-indigo-800"
        >
          Buscar por {suggestedLabel} ({fmt.format(suggestedAmount)}) →
        </button>
      )}

      <div className="mt-2 max-h-80 overflow-y-auto rounded-lg border border-slate-100">
        {pinned.map((r) => (
          <ResultRow key={r.id} row={r} checked disabled={false} onToggle={() => toggle(r)} />
        ))}
        {visible?.map((r) => (
          <ResultRow
            key={r.id}
            row={r}
            checked={selected.has(r.id)}
            disabled={readOnly || r.inSuggestion}
            onToggle={() => toggle(r)}
          />
        ))}
        {visible === null && pinned.length === 0 && (
          <p className="px-3 py-6 text-center text-[12px] text-slate-400">Buscá por nombre, CUIT, comprobante o importe.</p>
        )}
        {visible !== null && visible.length === 0 && pinned.length === 0 && (
          <p className="px-3 py-6 text-center text-[12px] text-slate-400">No hay nada sin conciliar con esos datos.</p>
        )}
      </div>
      {visible !== null && visible.length === 100 && (
        <p className="mt-1 text-[11px] text-slate-400">Se muestran los 100 más parecidos; afiná la búsqueda.</p>
      )}
    </section>
  );
}

function ConfirmList({ title, rows, total }: { title: string; rows: ManualSearchRow[]; total: number }) {
  return (
    <div className="rounded-xl border border-slate-200">
      <p className="flex justify-between border-b border-slate-100 px-3 py-2 text-[12px] font-semibold text-slate-700">
        {title}
        <span className="tabular-nums">{fmt.format(total)}</span>
      </p>
      <div className="max-h-56 overflow-y-auto">
        {rows.length === 0 ? (
          <p className="px-3 py-3 text-[12px] text-slate-400">Ninguno</p>
        ) : (
          rows.map((r) => (
            <div key={r.id} className="flex items-center gap-2 border-b border-slate-50 px-3 py-1.5 text-[11.5px] last:border-b-0">
              <span className="w-14 shrink-0 text-slate-500">{fmtDate.format(new Date(r.date))}</span>
              <span className="min-w-0 flex-1 truncate text-slate-700">{r.description}</span>
              <Amount value={r.amount} />
            </div>
          ))
        )}
      </div>
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
      className={`flex items-center gap-2.5 border-b border-slate-100 px-3 py-2 text-xs last:border-b-0 ${
        checked ? "bg-indigo-50/60" : ""
      } ${disabled ? "opacity-60" : "cursor-pointer hover:bg-slate-50"}`}
    >
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} className="accent-indigo-600" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-slate-700" title={row.description}>
          {row.description}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-slate-400">
          <SourceBadge source={row.source} />
          <span className="shrink-0">· {fmtDate.format(new Date(row.date))}</span>
          {(row.category || row.inSuggestion || row.accountRef) && (
            <span className="truncate">
              ·{" "}
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
      </span>
      <Amount value={row.amount} className="shrink-0" />
    </label>
  );
}
