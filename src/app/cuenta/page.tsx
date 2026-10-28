import { NavBar } from "@/components/nav-bar";
import { requireSession } from "@/lib/auth/session";
import { Card, CardHeader } from "@/components/ui";
import { ChangePasswordForm } from "./change-password-form";

export const dynamic = "force-dynamic";

export default async function CuentaPage({ searchParams }: { searchParams: Promise<{ primera?: string }> }) {
  const me = await requireSession();
  const { primera } = await searchParams;

  return (
    <div className="flex min-h-screen flex-col">
      <NavBar />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-slate-900">Mi cuenta</h1>
          <p className="mt-1 text-sm text-slate-500">
            {me.name} · usuario <span className="font-medium text-slate-700">{me.username}</span> ·{" "}
            {me.role === "admin" ? "Administrador" : "Solo lectura"}
          </p>
        </div>

        {(primera || me.mustChangePassword) && me.userId !== 0 && (
          <p className="mb-6 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
            Tu contraseña la generó otra persona. Elegí una propia para seguir.
          </p>
        )}

        <Card>
          <CardHeader title="Cambiar contraseña" />
          <div className="p-5">
            {me.userId === 0 ? (
              <p className="text-sm text-slate-600">
                Entraste con la llave de emergencia (la contraseña de Vercel), que no se cambia desde acá. Creá tu propio
                usuario administrador en <a href="/usuarios" className="font-medium text-indigo-600 underline">Usuarios</a>.
              </p>
            ) : (
              <ChangePasswordForm />
            )}
          </div>
        </Card>
      </main>
    </div>
  );
}
