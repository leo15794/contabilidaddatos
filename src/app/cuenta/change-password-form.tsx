"use client";

import { useActionState, useEffect, useRef } from "react";
import Link from "next/link";
import { changePasswordAction, type ChangePasswordState } from "./actions";
import { Button } from "@/components/ui";

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none transition-colors focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100";

export function ChangePasswordForm() {
  const [state, formAction, pending] = useActionState<ChangePasswordState | undefined, FormData>(
    changePasswordAction,
    undefined,
  );
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.success) formRef.current?.reset();
  }, [state?.success]);

  return (
    <form ref={formRef} action={formAction} className="max-w-sm space-y-3">
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-700">Contraseña actual</label>
        <input name="current" type="password" autoComplete="current-password" required className={inputClass} />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-700">Contraseña nueva (mínimo 10 caracteres)</label>
        <input name="next" type="password" autoComplete="new-password" required minLength={10} className={inputClass} />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-700">Repetí la contraseña nueva</label>
        <input name="repeat" type="password" autoComplete="new-password" required minLength={10} className={inputClass} />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Guardando..." : "Cambiar contraseña"}
      </Button>
      {state?.error && <p className="text-xs font-medium text-rose-600">{state.error}</p>}
      {state?.success && (
        <p className="text-xs font-medium text-emerald-600">
          {state.success}{" "}
          <Link href="/dashboard" className="underline">
            Ir al tablero
          </Link>
        </p>
      )}
    </form>
  );
}
