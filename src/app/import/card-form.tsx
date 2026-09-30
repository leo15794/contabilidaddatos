"use client";

import { useActionState } from "react";
import { importCardAction, ImportActionState } from "./actions";
import { ImportFeedback } from "./import-feedback";

const initial: ImportActionState = {};

export function CardImportForm() {
  const [state, formAction, pending] = useActionState(importCardAction, initial);

  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-700">Tarjeta</label>
        <input
          type="text"
          name="accountRef"
          placeholder="Ej: Visa Santander"
          required
          className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-700">Año del resumen</label>
        <input
          type="number"
          name="statementYear"
          placeholder={String(new Date().getFullYear())}
          className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        />
        <p className="mt-0.5 text-[11px] text-slate-400">
          Solo hace falta si el PDF no incluye el año en las fechas.
        </p>
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-700">Archivo PDF</label>
        <input type="file" name="file" accept=".pdf,application/pdf" required className="w-full text-sm" />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
      >
        {pending ? "Importando..." : "Importar"}
      </button>
      <ImportFeedback state={state} />
    </form>
  );
}
