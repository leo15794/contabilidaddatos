"use client";

import { useActionState, useState } from "react";
import Papa from "papaparse";
import { importBankAction, ImportActionState } from "./actions";
import { ImportFeedback } from "./import-feedback";

const initial: ImportActionState = {};

type Mode = "single" | "debit-credit";

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
    <form action={formAction} className="space-y-3">
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-700">Cuenta / banco</label>
        <input
          type="text"
          name="accountRef"
          placeholder="Ej: Banco Galicia CC"
          required
          className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-700">Archivo CSV</label>
        <input
          type="file"
          name="file"
          accept=".csv,text/csv"
          required
          onChange={handleFile}
          className="w-full text-sm"
        />
      </div>

      {headers.length > 0 && (
        <div className="space-y-2 rounded-md bg-slate-50 p-2">
          <p className="text-xs font-medium text-slate-700">Mapeo de columnas</p>
          <ColumnSelect label="Fecha" value={dateColumn} onChange={setDateColumn} headers={headers} />
          <ColumnSelect
            label="Descripción"
            value={descriptionColumn}
            onChange={setDescriptionColumn}
            headers={headers}
          />
          <div className="flex gap-2 text-xs">
            <label className="flex items-center gap-1">
              <input
                type="radio"
                checked={mode === "single"}
                onChange={() => setMode("single")}
              />
              Una columna de importe
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                checked={mode === "debit-credit"}
                onChange={() => setMode("debit-credit")}
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

      <button
        type="submit"
        disabled={pending || headers.length === 0}
        className="w-full rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
      >
        {pending ? "Importando..." : "Importar"}
      </button>
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
        className="rounded border border-slate-300 px-1 py-0.5"
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
