"use client";

import { useActionState, useRef, useEffect } from "react";
import { createPartnerAction, PartnerFormState } from "./actions";
import { Button } from "@/components/ui";

const initial: PartnerFormState = {};

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none transition-colors focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100";

/** Alta de un socio nuevo. En cuanto se guarda, cualquier movimiento de tarjeta cuyo titular coincida con este nombre pasa a contar para él automáticamente — no hace falta mapear nada más. */
export function NewPartnerForm() {
  const [state, formAction, pending] = useActionState(createPartnerAction, initial);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.success) formRef.current?.reset();
  }, [state.success]);

  return (
    <form ref={formRef} action={formAction} className="flex flex-wrap items-end gap-2">
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-700">Nombre del socio</label>
        <input
          name="name"
          required
          placeholder="Ej. Patricio Moloy"
          className={`${inputClass} w-56`}
        />
        <p className="mt-1 max-w-56 text-[11px] text-slate-400">
          Tiene que coincidir con el nombre del titular tal como aparece en el resumen de tarjeta.
        </p>
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-700">Teléfono (opcional)</label>
        <input name="phone" placeholder="Para más adelante (WhatsApp)" className={`${inputClass} w-56`} />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Agregando..." : "Agregar socio"}
      </Button>
      {state.error && <p className="w-full text-xs font-medium text-rose-600">{state.error}</p>}
      {state.success && <p className="w-full text-xs font-medium text-emerald-600">{state.success}</p>}
    </form>
  );
}
