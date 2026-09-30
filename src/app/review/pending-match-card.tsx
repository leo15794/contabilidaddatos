"use client";

import { useTransition } from "react";
import type { matches, transactions } from "@/db/schema";
import { resolveMatchAction } from "./actions";
import { Button, SourceBadge, Amount } from "@/components/ui";

const fmtDate = new Intl.DateTimeFormat("es-AR", { dateStyle: "short" });

type Match = typeof matches.$inferSelect;
type Txn = typeof transactions.$inferSelect;

export function PendingMatchCard({ match, transactions }: { match: Match; transactions: Txn[] }) {
  const [pending, startTransition] = useTransition();

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800">
          Confianza: {match.confidence}% · {match.note}
        </span>
        <div className="flex gap-2">
          <Button
            variant="success"
            size="sm"
            disabled={pending}
            onClick={() => startTransition(() => resolveMatchAction(match.id, "confirmed"))}
          >
            Confirmar
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() => startTransition(() => resolveMatchAction(match.id, "rejected"))}
          >
            Rechazar
          </Button>
        </div>
      </div>
      <div className="space-y-1.5 rounded-lg bg-white/70 p-2.5">
        {transactions.map((t) => (
          <div key={t.id} className="flex items-center justify-between gap-3 text-xs text-slate-700">
            <span className="flex min-w-0 items-center gap-2">
              <SourceBadge source={t.source} />
              <span className="text-slate-400">·</span>
              <span className="shrink-0 text-slate-500">{fmtDate.format(t.date)}</span>
              <span className="truncate">{t.description}</span>
            </span>
            <Amount value={Number(t.amount)} className="shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}
