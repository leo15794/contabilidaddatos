"use client";

import { useActionState } from "react";
import { importAfipAction, ImportActionState } from "./actions";
import { ImportFeedback } from "./import-feedback";
import { Button } from "@/components/ui";
import { IconUpload } from "@/components/icons";

const initial: ImportActionState = {};

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none transition-colors focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100";

export function AfipImportForm() {
  const [state, formAction, pending] = useActionState(importAfipAction, initial);

  return (
    <form action={formAction} className="space-y-3.5">
      <div>
        <label className="mb-1.5 block text-xs font-medium text-slate-700">Tipo</label>
        <select name="direction" defaultValue="received" className={inputClass}>
          <option value="received">Recibidas (compras/gastos)</option>
          <option value="issued">Emitidas (ventas)</option>
        </select>
      </div>
      <div>
        <label className="mb-1.5 block text-xs font-medium text-slate-700">Archivo CSV</label>
        <input
          type="file"
          name="file"
          accept=".csv,text/csv"
          required
          className="w-full text-xs text-slate-500 file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-50 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-indigo-700 hover:file:bg-indigo-100"
        />
      </div>
      <Button type="submit" disabled={pending} className="w-full">
        <IconUpload width={14} height={14} />
        {pending ? "Importando..." : "Importar"}
      </Button>
      <ImportFeedback state={state} />
    </form>
  );
}
