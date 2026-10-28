"use client";

import { useState, useTransition } from "react";
import { resetPasswordAction, setUserActiveAction, setUserRoleAction } from "./actions";
import { GeneratedPassword } from "./generated-password";

const linkButton = "rounded-md px-2 py-1 text-xs font-semibold transition-colors disabled:opacity-50";

export function UserRowActions({
  userId,
  username,
  role,
  active,
  isMe,
}: {
  userId: number;
  username: string;
  role: string;
  active: boolean;
  isMe: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<string | null>(null);

  const run = (fn: () => Promise<{ error?: string; password?: string }>) =>
    startTransition(async () => {
      const result = await fn();
      setError(result.error ?? null);
      if (result.password) setGenerated(result.password);
    });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap justify-end gap-1">
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            if (confirm(`¿Generar una contraseña nueva para "${username}"? La actual deja de funcionar.`)) {
              run(() => resetPasswordAction(userId));
            }
          }}
          className={`${linkButton} text-indigo-600 hover:bg-indigo-50`}
        >
          Nueva contraseña
        </button>
        {!isMe && (
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => setUserRoleAction(userId, role === "admin" ? "contador" : "admin"))}
              className={`${linkButton} text-slate-600 hover:bg-slate-100`}
            >
              {role === "admin" ? "Pasar a solo lectura" : "Hacer administrador"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => setUserActiveAction(userId, !active))}
              className={`${linkButton} ${active ? "text-rose-600 hover:bg-rose-50" : "text-emerald-600 hover:bg-emerald-50"}`}
            >
              {active ? "Desactivar" : "Reactivar"}
            </button>
          </>
        )}
      </div>
      {error && <p className="text-right text-xs text-rose-600">{error}</p>}
      {generated && <GeneratedPassword username={username} password={generated} />}
    </div>
  );
}
