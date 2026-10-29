"use server";

import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { appUsers } from "@/db/schema";
import { requireSession } from "@/lib/auth/session";

export type ChangePasswordState = { error?: string; success?: string };

export async function changePasswordAction(
  _prev: ChangePasswordState | undefined,
  formData: FormData,
): Promise<ChangePasswordState> {
  const me = await requireSession();
  if (me.userId === 0) {
    return { error: "Entraste con la llave de emergencia: creá tu usuario en Usuarios y cambiá la contraseña desde ahí." };
  }

  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  const repeat = String(formData.get("repeat") ?? "");

  if (next.length < 10) return { error: "La contraseña nueva tiene que tener al menos 10 caracteres." };
  if (next !== repeat) return { error: "Las dos contraseñas nuevas no coinciden." };

  const [user] = await db.select().from(appUsers).where(eq(appUsers.id, me.userId));
  if (!user || !(await bcrypt.compare(current, user.passwordHash))) {
    return { error: "La contraseña actual no es correcta." };
  }
  if (await bcrypt.compare(next, user.passwordHash)) return { error: "La nueva tiene que ser distinta de la actual." };

  await db
    .update(appUsers)
    .set({ passwordHash: await bcrypt.hash(next, 10), mustChangePassword: false })
    .where(eq(appUsers.id, me.userId));
  revalidatePath("/cuenta");
  return { success: "Listo, tu contraseña quedó cambiada." };
}
