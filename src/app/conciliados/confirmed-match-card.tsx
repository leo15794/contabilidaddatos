"use client";

import { useTransition } from "react";
import type { matches, transactions } from "@/db/schema";
import { resolveMatchAction } from "../review/actions";
import { Button, SourceBadge, Amount } from "@/components/ui";

const fmtDate = new Intl.DateTimeFormat("es-AR", { dateStyle: "short" });

type Match = typeof matches.$inferSelect;
type Txn = typeof transactions.$inferSelect;

const STRATEGY_LABELS: Record<string, string> = {
  exact_1to1: "Automático · exacto",
  card_statement_1toN: "Automático · resumen de tarjeta",
  fuzzy: "Automático · confirmado",
  manual: "Manual",
};

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  confirmed: { bg: "bg-emerald-100", text: "text-emerald-800", label: "Confirmado" },
  manual: { bg: "bg-indigo-100", text: "text-indigo-800", label: "Manual" },
  auto: { bg: "bg-sky-100", text: "text-sky-800", label: "Automático" },
};

export function ConfirmedMatchCard({ match, transactions }: { match: Match; transactions: Txn[] }) {
  const [pending, startTransition] = useTransition();
  const style = STATUS_STYLES[match.status] ?? { bg: "bg-slate-100", text: "text-slate-700", label: match.status };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-2 text-xs">
          <span className={`inline-flex items-center rounded-full px-2.5 py-1 font-medium ${style.bg} ${style.text}`}>
            {style.label}
          </span>
          <span className="text-slate-500">{STRATEGY_LABELS[match.strategy] ?? match.strategy}</span>
          {match.note && <span className="text-slate-400">· {match.note}</span>}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => startTransition(() => resolveMatchAction(match.id, "rejected"))}
        >
          Deshacer
        </Button>
      </div>
      <div className="space-y-1.5 rounded-lg bg-slate-50 p-2.5">
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
