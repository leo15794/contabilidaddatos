"use client";

import { useActionState, useState } from "react";
import Papa from "papaparse";
import { importBankAction, ImportActionState } from "./actions";
import { ImportFeedback } from "./import-feedback";
import { Button } from "@/components/ui";
import { IconUpload } from "@/components/icons";

const initial: ImportActionState = {};

type Mode = "single" | "debit-credit";

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none transition-colors focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100";

export function BankImportForm() {
  const [state, formAction, pending] = useActionState(importBankAction, initial);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mode, setMode] = useState<Mode>("single");
  const [dateColumn, setDateColumn] = useState("");
  const [descriptionColumn, setDescriptionColumn] = useState("");
  const [amountColumn, setAmountColumn] = useState("");
  const [debitColumn, setDebitColumn] = useState("");
  const [creditColumn, setCreditColumn] = useState("");

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then((text) => {
      const parsed = Papa.parse<Record<string, string>>(text, {
        header: true,
        skipEmptyLines: true,
        preview: 1,
      });
      setHeaders(parsed.meta.fields ?? []);
    });
  }

  const mapping =
    mode === "single"
      ? { dateColumn, descriptionColumn, amountColumn }
      : { dateColumn, descriptionColumn, debitColumn, creditColumn };

  return (
    <form action={formAction} className="space-y-3.5">
      <div>
        <label className="mb-1.5 block text-xs font-medium text-slate-700">Cuenta / banco</label>
        <input type="text" name="accountRef" placeholder="Ej: Banco Galicia CC" required className={inputClass} />
      </div>
      <div>
        <label className="mb-1.5 block text-xs font-medium text-slate-700">Archivo CSV</label>
        <input
          type="file"
          name="file"
          accept=".csv,text/csv"
          required
          onChange={handleFile}
          className="w-full text-xs text-slate-500 file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-50 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-indigo-700 hover:file:bg-indigo-100"
        />
      </div>

      {headers.length > 0 && (
        <div className="space-y-2.5 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <p className="text-xs font-medium text-slate-700">Mapeo de columnas</p>
          <ColumnSelect label="Fecha" value={dateColumn} onChange={setDateColumn} headers={headers} />
          <ColumnSelect
            label="Descripción"
            value={descriptionColumn}
            onChange={setDescriptionColumn}
            headers={headers}
          />
          <div className="flex gap-3 text-xs text-slate-600">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                checked={mode === "single"}
                onChange={() => setMode("single")}
                className="accent-indigo-600"
              />
              Una columna de importe
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                checked={mode === "debit-credit"}
                onChange={() => setMode("debit-credit")}
                className="accent-indigo-600"
              />
              Débito/Crédito separados
            </label>
          </div>
          {mode === "single" ? (
            <ColumnSelect label="Importe" value={amountColumn} onChange={setAmountColumn} headers={headers} />
          ) : (
            <>
              <ColumnSelect label="Débito" value={debitColumn} onChange={setDebitColumn} headers={headers} />
              <ColumnSelect label="Crédito" value={creditColumn} onChange={setCreditColumn} headers={headers} />
            </>
          )}
        </div>
      )}

      <input type="hidden" name="mapping" value={JSON.stringify(mapping)} />

      <Button type="submit" disabled={pending || headers.length === 0} className="w-full">
        <IconUpload width={14} height={14} />
        {pending ? "Importando..." : "Importar"}
      </Button>
      <ImportFeedback state={state} />
    </form>
  );
}

function ColumnSelect({
  label,
  value,
  onChange,
  headers,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  headers: string[];
}) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="text-slate-600">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-slate-300 px-1.5 py-1 text-xs outline-none focus:border-indigo-500"
      >
        <option value="">-- elegir --</option>
        {headers.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
    </div>
  );
}
