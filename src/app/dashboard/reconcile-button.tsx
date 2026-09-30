"use client";

import { useState, useTransition } from "react";
import { reconcileAction } from "./actions";

export function ReconcileButton() {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-3">
      {message && <span className="text-xs text-slate-500">{message}</span>}
      <button
        onClick={() =>
          startTransition(async () => {
            const result = await reconcileAction();
            setMessage(
              `${result.exactMatches + result.cardStatementMatches} matches nuevos, ${result.fuzzySuggestions} sugerencias, ${result.stillUnmatched} sin resolver`,
            );
          })
        }
        disabled={pending}
        className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
      >
        {pending ? "Conciliando..." : "Re-conciliar"}
      </button>
    </div>
  );
}
