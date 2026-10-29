"use client";

import { useActionState } from "react";
import { importMercadoLibreAction, ImportActionState } from "./actions";
import { ImportFeedback } from "./import-feedback";
import { Button } from "@/components/ui";
import { IconUpload } from "@/components/icons";

const initial: ImportActionState = {};

export function MercadoLibreImportForm() {
  const [state, formAction, pending] = useActionState(importMercadoLibreAction, initial);

  return (
    <form action={formAction} className="space-y-3.5">
      <div>
        <label className="mb-1.5 block text-xs font-medium text-slate-700">Reportes de compras (.csv, podés elegir varios)</label>
        <input
          type="file"
          name="file"
          accept=".csv,text/csv"
          multiple
          required
          className="w-full text-xs text-slate-500 file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-50 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-indigo-700 hover:file:bg-indigo-100"
        />
      </div>
      <p className="text-xs text-slate-400">
        MercadoLibre &gt; Compras &gt; Descargar reporte. No son pagos: sirven para unir cada factura con su cargo de tarjeta aunque el importe no coincida (cupones, cuotas, varios vendedores en un cargo).
      </p>
      <Button type="submit" disabled={pending} className="w-full">
        <IconUpload width={14} height={14} />
        {pending ? "Importando..." : "Importar"}
      </Button>
      <ImportFeedback state={state} />
    </form>
  );
}
