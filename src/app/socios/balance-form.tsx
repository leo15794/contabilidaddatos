"use client";

import { useActionState } from "react";
import { setPartnerBalanceAction, PartnerFormState } from "./actions";
import { Button } from "@/components/ui";

const initial: PartnerFormState = {};

/** Carga/actualiza el saldo asignado a este socio para el mes seleccionado. */
export function BalanceForm({
  partnerId,
  month,
  currentAmount,
}: {
  partnerId: number;
  month: string;
  currentAmount: number | null;
}) {
  const [state, formAction, pending] = useActionState(setPartnerBalanceAction, initial);

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="partnerId" value={partnerId} />
      <input type="hidden" name="month" value={month} />
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-700">Saldo asignado para este mes</label>
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-400">$</span>
          <input
            name="amount"
            type="text"
            inputMode="decimal"
            defaultValue={currentAmount ?? ""}
            placeholder="0,00"
            required
            className="w-36 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none transition-colors focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
          />
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Guardando..." : currentAmount !== null ? "Actualizar" : "Asignar"}
          </Button>
        </div>
      </div>
      {state.error && <p className="text-xs font-medium text-rose-600">{state.error}</p>}
    </form>
  );
}
