"use client";

import { useState } from "react";

/** Copia al portapapeles el texto del reclamo, listo para pegar en un mail o WhatsApp. */
export function CopyClaimButton({ text, label = "Copiar texto del reclamo", className = "" }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      }}
      className={className}
    >
      {copied ? "Copiado ✓" : label}
    </button>
  );
}
