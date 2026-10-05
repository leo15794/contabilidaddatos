"use client";

import { useActionState } from "react";
import { updatePartnerAction, PartnerFormState } from "./actions";
import { Button } from "@/components/ui";
import type { Partner } from "@/lib/partners";

const initial: PartnerFormState = {};

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none transition-colors focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100";

/** Edita un socio ya cargado — en particular el "alias", para los casos en que el banco imprime el nombre del titular distinto al nombre del socio (typos, inicial del medio, etc.) y por eso sus gastos no se estaban sumando. */
export function EditPartnerForm({ partner }: { partner: Partner }) {
  const [state, formAction, pending] = useActionState(updatePartnerAction, initial);

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="partnerId" value={partner.id} />
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-700">Nombre</label>
        <input name="name" defaultValue={partner.name} required className={`${inputClass} w-52`} />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-700">
          Alias (cómo lo escribe el banco, si es distinto)
        </label>
        <input
          name="aliasName"
          defaultValue={partner.aliasName ?? ""}
          placeholder="Ej. PATRICIO J MOLLOY"
          className={`${inputClass} w-60`}
        />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-700">Teléfono</label>
        <input name="phone" defaultValue={partner.phone ?? ""} className={`${inputClass} w-44`} />
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Guardando..." : "Guardar cambios"}
      </Button>
      {state.error && <p className="w-full text-xs font-medium text-rose-600">{state.error}</p>}
      {state.success && <p className="w-full text-xs font-medium text-emerald-600">{state.success}</p>}
    </form>
  );
}
