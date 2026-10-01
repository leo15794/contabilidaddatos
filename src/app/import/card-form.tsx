"use client";

import { useActionState } from "react";
import { importCardAction, ImportActionState } from "./actions";
import { ImportFeedback } from "./import-feedback";
import { Button } from "@/components/ui";
import { IconUpload } from "@/components/icons";

const initial: ImportActionState = {};

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none transition-colors focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100";

export function CardImportForm() {
  const [state, formAction, pending] = useActionState(importCardAction, initial);

  return (
    <form action={formAction} className="space-y-3.5">
      <div>
        <label className="mb-1.5 block text-xs font-medium text-slate-700">Tarjeta</label>
        <input type="text" name="accountRef" placeholder="Ej: Visa Santander" required className={inputClass} />
      </div>
      <div>
        <label className="mb-1.5 block text-xs font-medium text-slate-700">Año del resumen</label>
        <input
          type="number"
          name="statementYear"
          placeholder={String(new Date().getFullYear())}
          className={inputClass}
        />
        <p className="mt-1 text-[11px] text-slate-400">
          Solo hace falta si el PDF no incluye el año en las fechas.
        </p>
      </div>
      <div>
        <label className="mb-1.5 block text-xs font-medium text-slate-700">Archivo(s) PDF</label>
        <input
          type="file"
          name="file"
          accept=".pdf,application/pdf"
          multiple
          required
          className="w-full text-xs text-slate-500 file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-50 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-indigo-700 hover:file:bg-indigo-100"
        />
        <p className="mt-1 text-[11px] text-slate-400">
          Podés seleccionar varios resúmenes de una vez (ej: uno por mes) — se procesan todos con la misma tarjeta/año de acá arriba.
        </p>
      </div>
      <Button type="submit" disabled={pending} className="w-full">
        <IconUpload width={14} height={14} />
        {pending ? "Importando..." : "Importar"}
      </Button>
      <ImportFeedback state={state} />
    </form>
  );
}
