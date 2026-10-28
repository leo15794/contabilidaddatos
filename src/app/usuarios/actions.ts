"use server";

import { randomInt } from "node:crypto";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { appUsers } from "@/db/schema";
import { requireAdmin } from "@/lib/auth/session";

export type GeneratedPasswordState = { error?: string; username?: string; password?: string };

// Sin letras ni números que se confunden al dictarlos o copiarlos a mano (0/O, 1/l/I).
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Contraseña de 12 caracteres en tres bloques ("k7Pq-x3Mt-Rw9e"): fácil de pasar por WhatsApp. */
function generatePassword(): string {
  const block = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `${block()}-${block()}-${block()}`;
}

const USERNAME = /^[a-z0-9._-]{3,30}$/;

export async function createUserAction(
  _prev: GeneratedPasswordState | undefined,
  formData: FormData,
): Promise<GeneratedPasswordState> {
  await requireAdmin();
  const username = String(formData.get("username") ?? "").trim().toLowerCase();
  const name = String(formData.get("name") ?? "").trim();
  const role = formData.get("role") === "admin" ? "admin" : "contador";

  if (!USERNAME.test(username)) {
    return { error: "El usuario va en minúsculas, sin espacios, de 3 a 30 caracteres (letras, números, punto o guion)." };
  }
  if (!name) return { error: "Poné el nombre de la persona." };

  const [existing] = await db.select({ id: appUsers.id }).from(appUsers).where(eq(appUsers.username, username));
  if (existing) return { error: `Ya existe el usuario "${username}".` };

  const password = generatePassword();
  await db.insert(appUsers).values({
    username,
    name,
    role,
    passwordHash: await bcrypt.hash(password, 10),
    mustChangePassword: true,
  });

  revalidatePath("/usuarios");
  return { username, password };
}

export async function resetPasswordAction(userId: number): Promise<GeneratedPasswordState> {
  await requireAdmin();
  const [user] = await db.select().from(appUsers).where(eq(appUsers.id, userId));
  if (!user) return { error: "No existe ese usuario." };

  const password = generatePassword();
  await db
    .update(appUsers)
    .set({ passwordHash: await bcrypt.hash(password, 10), mustChangePassword: true })
    .where(eq(appUsers.id, userId));

  revalidatePath("/usuarios");
  return { username: user.username, password };
}

export async function setUserActiveAction(userId: number, active: boolean): Promise<{ error?: string }> {
  const me = await requireAdmin();
  if (me.userId === userId && !active) return { error: "No podés desactivar tu propio usuario." };
  await db.update(appUsers).set({ active }).where(eq(appUsers.id, userId));
  revalidatePath("/usuarios");
  return {};
}

export async function setUserRoleAction(userId: number, role: "admin" | "contador"): Promise<{ error?: string }> {
  const me = await requireAdmin();
  if (me.userId === userId && role !== "admin") return { error: "No podés quitarte el rol de administrador." };
  await db.update(appUsers).set({ role }).where(eq(appUsers.id, userId));
  revalidatePath("/usuarios");
  return {};
}
