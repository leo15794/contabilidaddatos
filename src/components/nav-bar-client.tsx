"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ComponentType, type SVGProps } from "react";
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
  IconUsers,
  IconScale,
  IconTrendingUp,
  IconLock,
  IconAlertTriangle,
} from "./icons";

type Icon = ComponentType<SVGProps<SVGSVGElement> & { width?: number; height?: number }>;
type NavItem = { href: string; label: string; icon: Icon; adminOnly?: boolean; badge?: "pending" | "unmatched" };

// Agrupado por lo que se hace (como Xero o Ramp), no por tabla de la base.
// adminOnly: pantallas para cargar o decidir; el contador (solo lectura) no las ve.
const GROUPS: { title: string | null; items: NavItem[] }[] = [
  { title: null, items: [{ href: "/dashboard", label: "Inicio", icon: IconLayoutDashboard }] },
  {
    title: "Conciliar",
    items: [
      { href: "/review", label: "Revisar sugerencias", icon: IconCheckCircle, adminOnly: true, badge: "pending" },
      { href: "/review#sin-conciliar", label: "Sin conciliar", icon: IconAlertTriangle, adminOnly: true, badge: "unmatched" },
      { href: "/conciliados", label: "Conciliados", icon: IconFileText },
    ],
  },
  { title: "Cuentas", items: [{ href: "/cuenta-corriente", label: "Clientes y proveedores", icon: IconScale }] },
  {
    title: "Datos",
    items: [
      { href: "/import", label: "Importar", icon: IconUpload, adminOnly: true },
      { href: "/importaciones", label: "Historial de cargas", icon: IconInbox, adminOnly: true },
    ],
  },
  {
    title: "Empresa",
    items: [
      { href: "/socios", label: "Socios", icon: IconUsers, adminOnly: true },
      { href: "/inversiones", label: "Inversiones", icon: IconTrendingUp },
      { href: "/usuarios", label: "Usuarios", icon: IconLock, adminOnly: true },
    ],
  },
];

// Link al dashboard de OpenWA (el gateway de WhatsApp self-hosted, ver
// openwa/ y la sección "Agente de WhatsApp" del README) — vive en el VPS,
// no en esta app, así que es un link externo, no una ruta de Next. Solo
// aparece si está configurado; si todavía no se levantó el VPS, no se
// muestra un botón roto.
const OPENWA_URL = process.env.NEXT_PUBLIC_OPENWA_URL;

export type SidebarProps = {
  readOnly: boolean;
  user: { name: string; roleLabel: string };
  counts: { pending: number; unmatched: number };
};

export function NavBarClient({ readOnly, user, counts }: SidebarProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const isActive = (href: string) => {
    const path = href.split("#")[0];
    if (href.includes("#")) return false;
    return pathname === path || pathname.startsWith(path + "/");
  };

  const content = (
    <div className="flex h-full flex-col">
      <Link href="/dashboard" className="flex items-center gap-2.5 px-5 pb-6 pt-5">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-violet-500 text-[13px] font-extrabold text-white shadow-sm">
          2D
        </span>
        <span className="leading-tight">
          <span className="block text-[13.5px] font-bold text-slate-900">2 Datos y Mercadeo</span>
          <span className="block text-[11px] text-slate-400">Conciliación contable</span>
        </span>
      </Link>

      <nav className="flex-1 space-y-5 overflow-y-auto px-3">
        {GROUPS.map((group) => {
          const items = group.items.filter((i) => !(readOnly && i.adminOnly));
          if (items.length === 0) return null;
          return (
            <div key={group.title ?? "main"}>
              {group.title && (
                <p className="px-2 pb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-slate-400">
                  {group.title}
                </p>
              )}
              {items.map((item) => {
                const active = isActive(item.href);
                const Icon = item.icon;
                const badge = item.badge ? counts[item.badge] : 0;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] font-medium transition-colors ${
                      active
                        ? "bg-white text-indigo-700 shadow-sm ring-1 ring-slate-200"
                        : "text-slate-600 hover:bg-white/70 hover:text-slate-900"
                    }`}
                  >
                    <Icon width={16} height={16} className="shrink-0" />
                    <span className="flex-1 truncate">{item.label}</span>
                    {badge > 0 && (
                      <span
                        className={`rounded-full px-1.5 text-[11px] font-semibold tabular-nums ${
                          item.badge === "pending" ? "bg-amber-100 text-amber-700" : "bg-slate-200/70 text-slate-600"
                        }`}
                      >
                        {badge}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          );
        })}
        {!readOnly && OPENWA_URL && (
          <a
            href={OPENWA_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] font-medium text-slate-600 hover:bg-white/70"
            title="Abrir el dashboard de OpenWA (gestión de la sesión de WhatsApp)"
          >
            <IconMessageCircle width={16} height={16} />
            <span className="flex-1">WhatsApp</span>
            <IconArrowUpRight width={12} height={12} className="text-slate-400" />
          </a>
        )}
      </nav>

      <div className="m-3 rounded-xl bg-white p-2.5 ring-1 ring-slate-200">
        <Link href="/cuenta" className="flex items-center gap-2.5 rounded-lg p-0.5 hover:bg-slate-50">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[12px] font-bold text-indigo-700">
            {initials(user.name)}
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-[12.5px] font-semibold text-slate-800">{user.name}</span>
            <span className={`block text-[11px] ${readOnly ? "font-semibold text-amber-600" : "text-slate-400"}`}>
              {user.roleLabel}
            </span>
          </span>
        </Link>
        <form action={logoutAction} className="mt-1.5 border-t border-slate-100 pt-1.5">
          <button
            type="submit"
            className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-[12px] text-slate-400 hover:bg-slate-50 hover:text-slate-700"
          >
            <IconLogOut width={14} height={14} />
            Salir
          </button>
        </form>
      </div>
    </div>
  );

  return (
    <>
      {/* Escritorio: barra fija a la izquierda (el contenido se corre con body:has([data-sidebar]) en globals.css). */}
      <aside data-sidebar className="fixed inset-y-0 left-0 z-20 hidden w-[248px] border-r border-slate-200 bg-slate-50 lg:block">
        {content}
      </aside>

      {/* Celular y tablet: barra arriba con botón de menú. */}
      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur lg:hidden">
        <Link href="/dashboard" className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-600 to-violet-500 text-[12px] font-extrabold text-white">
            2D
          </span>
          <span className="text-[13.5px] font-bold text-slate-900">2 Datos y Mercadeo</span>
        </Link>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg px-3 py-1.5 text-sm font-semibold text-slate-700 ring-1 ring-slate-200"
          aria-label="Abrir menú"
        >
          Menú
        </button>
      </header>
      {open && (
        <div className="fixed inset-0 z-30 lg:hidden">
          <button type="button" aria-label="Cerrar menú" onClick={() => setOpen(false)} className="absolute inset-0 bg-slate-900/30" />
          {/* En el celular el menú es un cajón: se cierra al tocar cualquier link. */}
          <aside
            className="absolute inset-y-0 left-0 w-[270px] bg-slate-50 shadow-xl"
            onClick={(e) => {
              if ((e.target as HTMLElement).closest("a")) setOpen(false);
            }}
          >
            {content}
          </aside>
        </div>
      )}
    </>
  );
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}
