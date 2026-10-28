"use server";

import bcrypt from "bcryptjs";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appUsers } from "@/db/schema";
import { createSession, destroySession } from "./session";

// Límite de intentos fallidos por IP. Vive en memoria de cada instancia
// serverless, así que no es un freno perfecto (cada instancia fría arranca de
// cero), pero corta el ataque más común —probar contraseñas a mano o con un
// script contra la misma instancia caliente— sin sumar infraestructura. Con una
// usuarios y bcrypt (lento a propósito) alcanza de sobra.
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const failedAttempts = new Map<string, { count: number; firstAt: number }>();

async function clientKey(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}

function isLockedOut(key: string): boolean {
  const entry = failedAttempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > LOCKOUT_MS) {
    failedAttempts.delete(key);
    return false;
  }
  return entry.count >= MAX_FAILED_ATTEMPTS;
}

function registerFailure(key: string) {
  const entry = failedAttempts.get(key);
  if (!entry || Date.now() - entry.firstAt > LOCKOUT_MS) {
    failedAttempts.set(key, { count: 1, firstAt: Date.now() });
  } else {
    entry.count++;
  }
}

// Solo rutas internas: "//sitio.com" o "https://..." convertirían el login en
// un redirect abierto hacia otro dominio.
function safeRedirectPath(from: string): string {
  return from.startsWith("/") && !from.startsWith("//") && !from.includes("\\") ? from : "/dashboard";
}

export async function loginAction(
  _prevState: { error?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string }> {
  const username = String(formData.get("username") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const from = safeRedirectPath(String(formData.get("from") ?? "/dashboard"));

  const key = await clientKey();
  if (isLockedOut(key)) {
    return { error: "Demasiados intentos fallidos. Esperá unos 15 minutos y probá de nuevo." };
  }

  // 1) Usuario de la base (los que se crean en /usuarios).
  if (username) {
    const [user] = await db.select().from(appUsers).where(eq(appUsers.username, username));
    if (user?.active && (await bcrypt.compare(password, user.passwordHash))) {
      failedAttempts.delete(key);
      await db.update(appUsers).set({ lastLoginAt: new Date() }).where(eq(appUsers.id, user.id));
      await createSession({ userId: user.id, username: user.username, role: user.role === "admin" ? "admin" : "contador" });
      // Si la contraseña la generó otro (alta o reseteo), primero la cambia.
      redirect(user.mustChangePassword ? "/cuenta?primera=1" : from);
    }
  }

  // 2) Llave de emergencia: la contraseña de Vercel (APP_PASSWORD_HASH) entra
  //    como administrador con cualquier usuario, o con el usuario vacío. Sirve
  //    para el primer ingreso y por si alguien queda afuera.
  const masterHash = process.env.APP_PASSWORD_HASH;
  if (masterHash && (await bcrypt.compare(password, masterHash))) {
    failedAttempts.delete(key);
    await createSession({ userId: 0, username: "admin", role: "admin" });
    redirect(from);
  }

  registerFailure(key);
  return { error: "Usuario o contraseña incorrectos." };
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}
