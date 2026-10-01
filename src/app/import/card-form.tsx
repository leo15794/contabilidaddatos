"use client";

import { useState } from "react";
import { importCardAction, ImportActionState } from "./actions";
import { ImportFeedback } from "./import-feedback";
import { Button } from "@/components/ui";
import { IconUpload } from "@/components/icons";

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none transition-colors focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100";

// Cada PDF se manda en un POST aparte (en vez de juntar todos en un solo
// request gigante) por dos razones: el límite de tamaño del body de un
// server action (15mb) se queda corto con varios resúmenes juntos, y leer
// cada uno con Claude puede tardar bastante — sumado entre muchos archivos
// fácil se pasa de los 60s que Vercel permite por invocación. Mandándolos
// de a uno, cada request es chico y rápido, y de paso se puede mostrar el
// progreso en vivo.
export function CardImportForm() {
  const [accountRef, setAccountRef] = useState("");
  const [statementYear, setStatementYear] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<ImportActionState>({});

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (files.length === 0 || !accountRef || pending) return;

    setPending(true);
    setResult({});
    setProgress({ done: 0, total: files.length });

    const successes: string[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const file of files) {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("accountRef", accountRef);
      if (statementYear) fd.append("statementYear", statementYear);

      try {
        const r = await importCardAction(undefined, fd);
        if (r.success) successes.push(r.success);
        if (r.error) errors.push(r.error);
        if (r.warnings) warnings.push(...r.warnings);
      } catch (err) {
        errors.push(`"${file.name}": fallo inesperado (${err instanceof Error ? err.message : String(err)}).`);
      }

      setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
    }

    setResult({
      success: successes.length > 0 ? successes.join("\n") : undefined,
      error: errors.length > 0 ? errors.join("\n") : undefined,
      warnings,
    });
    setPending(false);
    setProgress(null);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3.5">
      <div>
        <label className="mb-1.5 block text-xs font-medium text-slate-700">Tarjeta</label>
        <input
          type="text"
          placeholder="Ej: Visa Santander"
          required
          className={inputClass}
          value={accountRef}
          onChange={(e) => setAccountRef(e.target.value)}
        />
      </div>
      <div>
        <label className="mb-1.5 block text-xs font-medium text-slate-700">Año del resumen</label>
        <input
          type="number"
          placeholder={String(new Date().getFullYear())}
          className={inputClass}
          value={statementYear}
          onChange={(e) => setStatementYear(e.target.value)}
        />
        <p className="mt-1 text-[11px] text-slate-400">
          Solo hace falta si el PDF no incluye el año en las fechas.
        </p>
      </div>
      <div>
        <label className="mb-1.5 block text-xs font-medium text-slate-700">Archivo(s) PDF o Excel</label>
        <input
          type="file"
          accept=".pdf,application/pdf,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          multiple
          required
          className="w-full text-xs text-slate-500 file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-50 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-indigo-700 hover:file:bg-indigo-100"
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
        />
        <p className="mt-1 text-[11px] text-slate-400">
          Podés seleccionar varios resúmenes de una vez (ej: uno por mes) — se procesan todos con la misma tarjeta/año
          de acá arriba, uno por uno. Si un PDF no se puede leer (ni por texto ni con el lector visual), subí un Excel
          con el mismo formato en su lugar — columnas: tarjeta, titular, subtotal_impreso, tipo (consumo/cargo),
          fecha, comprobante, descripcion, cuotas, importe.
        </p>
      </div>
      <Button type="submit" disabled={pending} className="w-full">
        <IconUpload width={14} height={14} />
        {pending && progress ? `Importando ${progress.done}/${progress.total}...` : pending ? "Importando..." : "Importar"}
      </Button>
      <ImportFeedback state={result} />
    </form>
  );
}
