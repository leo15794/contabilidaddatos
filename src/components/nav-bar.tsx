import Link from "next/link";
import { logoutAction } from "@/lib/auth/actions";

const LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/import", label: "Importar" },
  { href: "/review", label: "Revisión" },
];

export function NavBar() {
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
        <div className="flex items-center gap-6">
          <span className="text-sm font-semibold text-slate-900">
            2 Datos y Mercadeo
          </span>
          <nav className="flex gap-4">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="text-sm text-slate-600 hover:text-slate-900"
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
        <form action={logoutAction}>
          <button type="submit" className="text-sm text-slate-400 hover:text-slate-700">
            Salir
          </button>
        </form>
      </div>
    </header>
  );
}
