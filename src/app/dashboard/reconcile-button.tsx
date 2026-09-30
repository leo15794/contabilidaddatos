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
              `${result.exactMatches + result.cardStatementMatches} matches nuevos, ${result.fuzzySuggestions} sugerencias, ${result.stillUnmatched} sin resolver`,
            );
          })
        }
        disabled={pending}
      >
        <IconSparkles width={15} height={15} />
        {pending ? "Conciliando..." : "Re-conciliar"}
      </Button>
    </div>
  );
}
