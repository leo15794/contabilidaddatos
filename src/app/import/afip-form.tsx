"use client";

import { useActionState } from "react";
import { importAfipAction, ImportActionState } from "./actions";
import { ImportFeedback } from "./import-feedback";

const initial: ImportActionState = {};

export function AfipImportForm() {
  const [state, formAction, pending] = useActionState(importAfipAction, initial);

  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-700">Tipo</label>
        <select
          name="direction"
          defaultValue="received"
          className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        >
          <option value="received">Recibidas (compras/gastos)</option>
          <option value="issued">Emitidas (ventas)</option>
        </select>
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-700">Archivo CSV</label>
        <input
          type="file"
          name="file"
          accept=".csv,text/csv"
          required
          className="w-full text-sm"
        />
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
