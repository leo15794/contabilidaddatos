"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logoutAction } from "@/lib/auth/actions";
import {
  IconLayoutDashboard,
  IconUpload,
  IconCheckCircle,
  IconFileText,
  IconInbox,
  IconMessageCircle,
  IconLogOut,
  IconArrowUpRight,
} from "./icons";

const LINKS = [
  { href: "/dashboard", label: "Dashboard", icon: IconLayoutDashboard },
  { href: "/import", label: "Importar", icon: IconUpload },
  { href: "/importaciones", label: "Importaciones", icon: IconInbox },
  { href: "/review", label: "Revisión", icon: IconCheckCircle },
  { href: "/conciliados", label: "Conciliados", icon: IconFileText },
];

// Link al dashboard de OpenWA (el gateway de WhatsApp self-hosted, ver
// openwa/ y la sección "Agente de WhatsApp" del README) — vive en el VPS,
// no en esta app, así que es un link externo, no una ruta de Next. Solo
// aparece si está configurado; si todavía no se levantó el VPS, no se
// muestra un botón roto.
const OPENWA_URL = process.env.NEXT_PUBLIC_OPENWA_URL;

export function NavBar() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/80 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
        <div className="flex items-center gap-8">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white shadow-sm">
              2D
            </span>
            <div className="leading-tight">
              <p className="text-sm font-semibold text-slate-900">2 Datos y Mercadeo</p>
              <p className="text-[11px] text-slate-400">Conciliación contable</p>
            </div>
          </div>
          <nav className="flex gap-1">
            {LINKS.map((l) => {
              const active = pathname === l.href || pathname.startsWith(l.href + "/");
              const Icon = l.icon;
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                    active
                      ? "bg-indigo-50 text-indigo-700"
                      : "text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                  }`}
                >
                  <Icon width={15} height={15} />
                  {l.label}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="flex items-center gap-1">
          {OPENWA_URL && (
            <a
              href={OPENWA_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
              title="Abrir el dashboard de OpenWA (gestión de la sesión de WhatsApp)"
            >
              <IconMessageCircle width={15} height={15} />
              WhatsApp
              <IconArrowUpRight width={12} height={12} className="text-slate-400" />
            </a>
          )}
          <form action={logoutAction}>
            <button
              type="submit"
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            >
              <IconLogOut width={15} height={15} />
              Salir
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
