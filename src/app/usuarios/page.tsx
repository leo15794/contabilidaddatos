import { asc } from "drizzle-orm";
import { NavBar } from "@/components/nav-bar";
import { db } from "@/db";
import { appUsers } from "@/db/schema";
import { requireAdmin } from "@/lib/auth/session";
import { Card, CardHeader, EmptyState } from "@/components/ui";
import { IconUsers } from "@/components/icons";
import { NewUserForm } from "./new-user-form";
import { UserRowActions } from "./user-row-actions";

export const dynamic = "force-dynamic";

const fmtDate = new Intl.DateTimeFormat("es-AR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Argentina/Buenos_Aires",
});

export default async function UsuariosPage() {
  const me = await requireAdmin();
  const users = await db.select().from(appUsers).orderBy(asc(appUsers.name));

  return (
    <div className="flex min-h-screen flex-col">
      <NavBar />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-slate-900">Usuarios</h1>
          <p className="mt-1 text-sm text-slate-500">
            Quién entra a la app y con qué permisos. Las contraseñas las genera el sistema: se muestran una sola vez para
            que se las pases a la persona, y al entrar le pide cambiarla.
          </p>
          {me.userId === 0 && (
            <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
              Entraste con la llave de emergencia (la contraseña de Vercel). Creá tu propio usuario administrador acá y
              usalo de ahora en adelante.
            </p>
          )}
        </div>

        <Card className="mb-6">
          <CardHeader title="Nuevo usuario" />
          <div className="p-5">
            <NewUserForm />
          </div>
        </Card>

        <Card>
          <CardHeader title="Usuarios" subtitle={`${users.length} en total`} />
          {users.length === 0 ? (
            <EmptyState icon={<IconUsers width={20} height={20} />} title="Todavía no hay usuarios" />
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-6 py-2.5 font-medium">Usuario</th>
                  <th className="px-6 py-2.5 font-medium">Permisos</th>
                  <th className="px-6 py-2.5 font-medium">Último ingreso</th>
                  <th className="px-6 py-2.5 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className={`border-t border-slate-100 align-top ${u.active ? "" : "opacity-60"}`}>
                    <td className="px-6 py-3">
                      <p className="font-medium text-slate-800">{u.name}</p>
                      <p className="text-xs text-slate-500">
                        {u.username}
                        {!u.active && " · desactivado"}
                        {u.active && u.mustChangePassword && " · todavía no cambió la contraseña"}
                      </p>
                    </td>
                    <td className="whitespace-nowrap px-6 py-3">
                      <span
                        className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                          u.role === "admin" ? "bg-indigo-50 text-indigo-700" : "bg-amber-50 text-amber-700"
                        }`}
                      >
                        {u.role === "admin" ? "Administrador" : "Solo lectura"}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-6 py-3 text-xs text-slate-500">
                      {u.lastLoginAt ? fmtDate.format(u.lastLoginAt) : "Nunca"}
                    </td>
                    <td className="px-6 py-3">
                      <UserRowActions
                        userId={u.id}
                        username={u.username}
                        role={u.role}
                        active={u.active}
                        isMe={u.id === me.userId}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </main>
    </div>
  );
}
