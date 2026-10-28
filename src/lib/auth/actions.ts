"use server";

import bcrypt from "bcryptjs";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createSession, destroySession, type Role } from "./session";

// Límite de intentos fallidos por IP. Vive en memoria de cada instancia
// serverless, así que no es un freno perfecto (cada instancia fría arranca de
// cero), pero corta el ataque más común —probar contraseñas a mano o con un
// script contra la misma instancia caliente— sin sumar infraestructura. Con una
// sola contraseña y bcrypt (lento a propósito) alcanza de sobra.
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
  const password = String(formData.get("password") ?? "");
  const from = safeRedirectPath(String(formData.get("from") ?? "/dashboard"));

  const hash = process.env.APP_PASSWORD_HASH;
  if (!hash) {
    return {
      error:
        "Falta configurar APP_PASSWORD_HASH en las variables de entorno del servidor.",
    };
  }

  const key = await clientKey();
  if (isLockedOut(key)) {
    return { error: "Demasiados intentos fallidos. Esperá unos 15 minutos y probá de nuevo." };
  }

  // Segunda contraseña, opcional: la del contador (solo lectura).
  const accountantHash = process.env.APP_ACCOUNTANT_PASSWORD_HASH;
  const role: Role | null = (await bcrypt.compare(password, hash))
    ? "admin"
    : accountantHash && (await bcrypt.compare(password, accountantHash))
      ? "contador"
      : null;
  if (!role) {
    registerFailure(key);
    return { error: "Contraseña incorrecta." };
  }

  failedAttempts.delete(key);
  await createSession(role);
  redirect(from);
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}
