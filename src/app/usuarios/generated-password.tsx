"use client";

import { useState } from "react";

/** La contraseña generada se muestra una sola vez: después solo queda su hash en la base. */
export function GeneratedPassword({ username, password }: { username: string; password: string }) {
  const [copied, setCopied] = useState(false);
  const text = `Usuario: ${username}\nContraseña: ${password}`;

  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm">
      <p className="font-semibold text-emerald-800">Contraseña generada para “{username}”</p>
      <p className="mt-1.5 font-mono text-base tracking-wide text-slate-900">{password}</p>
      <p className="mt-1.5 text-xs text-emerald-700">
        Copiala y pasásela ahora: no se vuelve a mostrar. Al entrar por primera vez le va a pedir que la cambie.
      </p>
      <button
        type="button"
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        }}
        className="mt-2 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
      >
        {copied ? "Copiado ✓" : "Copiar usuario y contraseña"}
      </button>
    </div>
  );
}
