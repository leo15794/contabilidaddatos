"use client";

import { useState, useTransition } from "react";
import type { transactions } from "@/db/schema";
import { createManualMatchAction } from "./actions";
import { Button, SourceBadge, Amount, EmptyState } from "@/components/ui";
import { IconInbox } from "@/components/icons";

const fmtDate = new Intl.DateTimeFormat("es-AR", { dateStyle: "short" });

type Txn = typeof transactions.$inferSelect;

export function UnmatchedList({ transactions }: { transactions: Txn[] }) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [pending, startTransition] = useTransition();

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (transactions.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white">
        <EmptyState
          icon={<IconInbox width={20} height={20} />}
          title="Todo lo demás está conciliado o en revisión"
        />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs text-slate-500">{selected.size} seleccionados</span>
        <Button
          size="sm"
          disabled={selected.size < 2 || pending}
          onClick={() =>
            startTransition(async () => {
              await createManualMatchAction(Array.from(selected));
              setSelected(new Set());
            })
          }
        >
          Unir seleccionados
        </Button>
      </div>
      <div className="max-h-96 overflow-y-auto rounded-xl border border-slate-200 bg-white">
        {transactions.map((t) => (
          <label
            key={t.id}
            className="flex cursor-pointer items-center gap-3 border-b border-slate-100 px-3.5 py-2.5 text-xs last:border-b-0 hover:bg-slate-50"
          >
            <input
              type="checkbox"
              checked={selected.has(t.id)}
              onChange={() => toggle(t.id)}
              className="accent-indigo-600"
            />
            <span className="w-28 shrink-0">
              <SourceBadge source={t.source} />
            </span>
            <span className="w-20 shrink-0 text-slate-500">{fmtDate.format(t.date)}</span>
            <span className="flex-1 truncate text-slate-700">{t.description}</span>
            <Amount value={Number(t.amount)} />
          </label>
        ))}
      </div>
    </div>
  );
}
