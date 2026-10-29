"use client";

import { useEffect, useState, useTransition } from "react";
import { resolveMatchAction, resolveManyAction } from "./actions";
import type { SideItem, SuggestionView } from "./suggestion-view";

const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });

const SIDE_STYLES: Record<string, { label: string; dot: string; text: string }> = {
  bank: { label: "Movimiento de banco", dot: "bg-blue-500", text: "text-blue-600" },
  card: { label: "Consumo de tarjeta", dot: "bg-violet-500", text: "text-violet-600" },
  cash: { label: "Pago en efectivo", dot: "bg-lime-500", text: "text-lime-700" },
  ticket: { label: "Ticket (WhatsApp)", dot: "bg-green-500", text: "text-green-600" },
  retention: { label: "Retención", dot: "bg-amber-500", text: "text-amber-600" },
  afip_issued: { label: "Factura emitida (AFIP)", dot: "bg-cyan-500", text: "text-cyan-600" },
  afip_received: { label: "Factura recibida (AFIP)", dot: "bg-teal-500", text: "text-teal-600" },
};

/**
 * Cola de sugerencias al estilo de la conciliación de Xero: una por vez, el
 * movimiento de plata a la izquierda y el comprobante a la derecha. Enter
 * confirma, X rechaza y las flechas pasan a la siguiente o la anterior.
 */
export function ReviewQueue({ suggestions }: { suggestions: SuggestionView[] }) {
  const [activeId, setActiveId] = useState<number | null>(suggestions[0]?.id ?? null);
  const [pending, startTransition] = useTransition();

  // Si la activa ya se resolvió (la lista vino de nuevo del servidor), se pasa a la primera que quede.
  const active = suggestions.find((s) => s.id === activeId) ?? suggestions[0] ?? null;
  const activeIndex = active ? suggestions.indexOf(active) : -1;

  const resolve = (decision: "confirmed" | "rejected") => {
    if (!active || pending) return;
    const next = suggestions[activeIndex + 1] ?? suggestions[activeIndex - 1] ?? null;
    startTransition(async () => {
      await resolveMatchAction(active.id, decision);
      setActiveId(next?.id ?? null);
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "Enter") {
        e.preventDefault();
        resolve("confirmed");
      } else if (e.key === "x" || e.key === "X") {
        resolve("rejected");
      } else if (e.key === "ArrowDown" || e.key === "j") {
        const n = suggestions[activeIndex + 1];
        if (n) setActiveId(n.id);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        const p = suggestions[activeIndex - 1];
        if (p) setActiveId(p.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!active) {
    return (
      <div className="rounded-2xl bg-white px-6 py-12 text-center ring-1 ring-slate-200">
        <p className="text-3xl">✓</p>
        <p className="mt-2 text-[15px] font-semibold text-slate-900">No quedan sugerencias para revisar</p>
        <p className="mt-1 text-[13px] text-slate-500">Cuando el motor encuentre una pareja probable, va a aparecer acá.</p>
      </div>
    );
  }

  const highConfidence = suggestions.filter((s) => s.confidence >= 90);
  const others = suggestions.filter((s) => s.id !== active.id);
  const diffPct = active.documentsTotal !== 0 ? Math.abs(active.diff / active.documentsTotal) * 100 : 0;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <p className="text-[13px] font-semibold tabular-nums text-slate-700">
            {activeIndex + 1} de {suggestions.length}
          </p>
          <div className="h-1.5 w-40 overflow-hidden rounded-full bg-slate-200">
            <div className="h-full rounded-full bg-indigo-500" style={{ width: `${((activeIndex + 1) / suggestions.length) * 100}%` }} />
          </div>
        </div>
        {highConfidence.length > 1 && (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              if (confirm(`¿Confirmar las ${highConfidence.length} sugerencias con 90% o más de confianza?`)) {
                startTransition(() => resolveManyAction(highConfidence.map((s) => s.id), "confirmed"));
              }
            }}
            className="rounded-lg bg-white px-3.5 py-2 text-[12.5px] font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50 disabled:opacity-50"
          >
            Confirmar las {highConfidence.length} de 90% o más
          </button>
        )}
      </div>

      {/* Sugerencia activa */}
      <div className={`rounded-2xl bg-white shadow-sm ring-2 ring-indigo-500 transition-opacity ${pending ? "opacity-60" : ""}`}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-6 py-3">
          <div className="flex min-w-0 flex-1 items-center gap-2 text-[12.5px]">
            <ConfidenceBadge value={active.confidence} />
            {active.note && <span className="line-clamp-2 text-slate-500" title={cleanNote(active.note)}>{cleanNote(active.note)}</span>}
          </div>
          <span className="text-[12px] text-slate-400">Sugerencia #{active.id}</span>
        </div>

        <div className="grid md:grid-cols-[1fr_120px_1fr]">
          <Side items={active.payments} total={active.paymentsTotal} />
          <div className="flex flex-row items-center justify-center gap-3 border-y border-dashed border-slate-200 bg-slate-50/60 py-3 md:flex-col md:border-x md:border-y-0 md:py-0">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-indigo-600 shadow ring-1 ring-slate-200">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M8 7h12m0 0l-4-4m4 4l-4 4M16 17H4m0 0l4 4m-4-4l4-4" />
              </svg>
            </span>
            {Math.abs(active.diff) < 0.01 ? (
              <p className="text-center text-[11.5px] font-semibold text-emerald-600">Exacto</p>
            ) : (
              <div className="text-center">
                <p className="text-[11.5px] font-semibold tabular-nums text-amber-600">dif. {fmt.format(Math.abs(active.diff))}</p>
                <p className="text-[11px] tabular-nums text-slate-400">{diffPct.toLocaleString("es-AR", { maximumFractionDigits: 2 })}%</p>
              </div>
            )}
          </div>
          <Side items={active.documents} total={active.documentsTotal} />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/60 px-6 py-3.5">
          <p className="text-[12px] text-slate-500">
            Atajos: <Kbd>Enter</Kbd> confirma · <Kbd>X</Kbd> rechaza · <Kbd>↓</Kbd> <Kbd>↑</Kbd> cambian de sugerencia
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => resolve("rejected")}
              className="rounded-lg bg-white px-4 py-2 text-[13px] font-semibold text-rose-600 ring-1 ring-slate-200 hover:bg-rose-50 disabled:opacity-50"
            >
              Rechazar <span className="ml-1 text-[11px] text-slate-400">X</span>
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => resolve("confirmed")}
              className="rounded-lg bg-indigo-600 px-5 py-2 text-[13px] font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
            >
              Confirmar cruce <span className="ml-1 text-[11px] text-indigo-200">↵</span>
            </button>
          </div>
        </div>
      </div>

      {/* Las demás */}
      {others.length > 0 && (
        <>
          <p className="mt-6 text-[12px] font-semibold uppercase tracking-wider text-slate-400">Siguientes</p>
          <div className="mt-2 space-y-2">
            {others.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setActiveId(s.id)}
                className="grid w-full grid-cols-1 items-center gap-2 rounded-xl bg-white px-5 py-3 text-left text-[13px] ring-1 ring-slate-200 hover:ring-indigo-300 md:grid-cols-[1fr_110px_1fr_auto] md:gap-4"
              >
                <RowSide items={s.payments} />
                <p className={`text-[12px] font-semibold tabular-nums md:text-center ${Math.abs(s.diff) < 0.01 ? "text-emerald-600" : "text-amber-600"}`}>
                  {Math.abs(s.diff) < 0.01 ? "exacto" : `dif. ${fmt.format(Math.abs(s.diff))}`}
                </p>
                <RowSide items={s.documents} />
                <div className="flex items-center gap-3">
                  <span className="font-semibold tabular-nums">{fmt.format(s.paymentsTotal)}</span>
                  <ConfidenceBadge value={s.confidence} small />
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Side({ items, total }: { items: SideItem[]; total: number }) {
  const first = items[0];
  const style = first ? SIDE_STYLES[first.source] ?? SIDE_STYLES.bank : SIDE_STYLES.bank;
  const many = items.length > 1;
  return (
    <div className="min-w-0 p-6">
      <p className={`flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider ${style.text}`}>
        <i className={`h-2 w-2 rounded-full ${style.dot}`} />
        {many ? `${items.length} comprobantes` : style.label}
      </p>
      {many ? (
        <div className="mt-3 space-y-2">
          {items.map((it) => (
            <div key={it.id} className="flex items-start justify-between gap-3 text-[12.5px]">
              <div className="min-w-0">
                <p className="truncate font-medium text-slate-800">{it.title}</p>
                <p className="truncate text-[11.5px] text-slate-500">
                  {it.subtitle} · {it.date}
                </p>
              </div>
              <p className={`shrink-0 font-medium tabular-nums ${it.amount < 0 ? "text-rose-600" : "text-slate-800"}`}>{fmt.format(it.amount)}</p>
            </div>
          ))}
          <div className="flex justify-between border-t border-slate-200 pt-2 text-[13px] font-semibold">
            <span>Total</span>
            <span className="tabular-nums">{fmt.format(total)}</span>
          </div>
        </div>
      ) : first ? (
        <>
          <p className="mt-3 truncate text-[17px] font-semibold text-slate-900">{first.title}</p>
          <p className="mt-1 truncate text-[12.5px] text-slate-500">{first.subtitle}</p>
          <div className="mt-5 flex items-end justify-between gap-3">
            <div>
              <p className="text-[11.5px] text-slate-400">Fecha</p>
              <p className="text-[14px] font-medium capitalize">{first.date}</p>
            </div>
            <div className="text-right">
              <p className="text-[11.5px] text-slate-400">Importe</p>
              <p className="text-[22px] font-bold tabular-nums text-slate-900">{fmt.format(first.amount)}</p>
            </div>
          </div>
        </>
      ) : (
        <p className="mt-3 text-[12.5px] text-slate-400">—</p>
      )}
    </div>
  );
}

function RowSide({ items }: { items: SideItem[] }) {
  const first = items[0];
  if (!first) return <span className="text-slate-400">—</span>;
  return (
    <div className="min-w-0">
      <p className="truncate font-medium text-slate-800">
        {first.title}
        {items.length > 1 && <span className="text-slate-400"> +{items.length - 1}</span>}
      </p>
      <p className="truncate text-[12px] text-slate-500">
        {first.subtitle} · {first.date}
      </p>
    </div>
  );
}

function ConfidenceBadge({ value, small = false }: { value: number; small?: boolean }) {
  const tone = value >= 90 ? "bg-emerald-50 text-emerald-700" : value >= 70 ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-600";
  return (
    <span className={`shrink-0 rounded-full font-semibold ${tone} ${small ? "px-2 py-0.5 text-[11.5px]" : "px-2.5 py-1 text-[12px]"}`}>
      {small ? `${value}%` : `Confianza ${value}%`}
    </span>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-slate-300 bg-white px-1.5 text-[11px] text-slate-600">{children}</kbd>;
}

/** Las notas del motor empiezan con "Sugerencia automática — ...": esa parte ya la dice la pantalla. */
function cleanNote(note: string) {
  return note.replace(/^Sugerencia automática\s*[—-]\s*/i, "");
}
