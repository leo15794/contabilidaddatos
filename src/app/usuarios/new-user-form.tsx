"use client";

import { useActionState, useEffect, useRef } from "react";
import { createUserAction, type GeneratedPasswordState } from "./actions";
import { GeneratedPassword } from "./generated-password";
import { Button } from "@/components/ui";

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none transition-colors focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100";

export function NewUserForm() {
  const [state, formAction, pending] = useActionState<GeneratedPasswordState | undefined, FormData>(
    createUserAction,
    undefined,
  );
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.password) formRef.current?.reset();
  }, [state?.password]);

  return (
    <div className="space-y-3">
      <form ref={formRef} action={formAction} className="flex flex-wrap items-end gap-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-700">Usuario</label>
          <input name="username" required placeholder="ej. contador" autoCapitalize="none" className={`${inputClass} w-44`} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-700">Nombre</label>
          <input name="name" required placeholder="ej. Estudio Pérez" className={`${inputClass} w-56`} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-700">Permisos</label>
          <select name="role" defaultValue="contador" className={`${inputClass} w-52`}>
            <option value="contador">Solo lectura (ve y exporta)</option>
            <option value="admin">Administrador (todo)</option>
          </select>
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? "Creando..." : "Crear y generar contraseña"}
        </Button>
      </form>
      {state?.error && <p className="text-xs font-medium text-rose-600">{state.error}</p>}
      {state?.password && state.username && <GeneratedPassword username={state.username} password={state.password} />}
    </div>
  );
}
