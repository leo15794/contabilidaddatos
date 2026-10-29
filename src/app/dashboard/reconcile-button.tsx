"use client";

import { useState, useTransition } from "react";
import { reconcileAction } from "./actions";
import { Button } from "@/components/ui";
import { IconSparkles } from "@/components/icons";

export function ReconcileButton() {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-3">
      {message && <span className="text-xs text-slate-500">{message}</span>}
      <Button
        onClick={() =>
          startTransition(async () => {
            const result = await reconcileAction();
            setMessage(
              `${result.exactMatches + result.cardStatementMatches + result.creditNoteMatches} matches nuevos, ${result.cuitGroupMatches + result.paymentGroupMatches} grupos por cliente/proveedor, ${result.fuzzySuggestions} sugerencias, ${result.stillUnmatched} sin resolver`,
            );
          })
        }
        disabled={pending}
        variant="secondary"
        size="sm"
        className="bg-white py-2 ring-1 ring-slate-200 hover:bg-slate-50"
      >
        <IconSparkles width={15} height={15} />
        {pending ? "Conciliando..." : "Re-conciliar"}
      </Button>
    </div>
  );
}
