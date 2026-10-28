"use client";

import { useActionState } from "react";
import { importCashAction, ImportActionState } from "./actions";
import { ImportFeedback } from "./import-feedback";
import { Button } from "@/components/ui";
import { IconUpload } from "@/components/icons";

const initial: ImportActionState = {};

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none transition-colors focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100";

export function CashImportForm() {
  const [state, formAction, pending] = useActionState(importCashAction, initial);

  return (
    <form action={formAction} className="space-y-3.5">
      <div>
        <label className="mb-1.5 block text-xs font-medium text-slate-700">Año (solo si alguna fecha está escrita sin año)</label>
        <input type="number" name="year" defaultValue={new Date().getFullYear()} min={2020} max={2100} required className={inputClass} />
      </div>
      <div>
        <label className="mb-1.5 block text-xs font-medium text-slate-700">Planilla de contabilidad (.xlsx)</label>
        <input
          type="file"
          name="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          required
          className="w-full text-xs text-slate-500 file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-50 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-indigo-700 hover:file:bg-indigo-100"
        />
      </div>
      <p className="text-xs text-slate-400">Se leen solo las filas de la hoja &quot;Gastos Socios&quot; pagadas en efectivo. Se puede volver a subir entera: lo ya cargado se saltea.</p>
      <Button type="submit" disabled={pending} className="w-full">
        <IconUpload width={14} height={14} />
        {pending ? "Importando..." : "Importar"}
      </Button>
      <ImportFeedback state={state} />
    </form>
  );
}
