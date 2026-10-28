import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

const COOKIE_NAME = "session";
const SESSION_DURATION_SECONDS = 60 * 60 * 24 * 30; // 30 días

function getSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "Falta AUTH_SECRET (o es muy corto). Configurala en .env.local / Vercel con al menos 16 caracteres aleatorios.",
    );
  }
  return new TextEncoder().encode(secret);
}

/**
 * "admin": Leo, hace todo. "contador": acceso de solo lectura con su propia
 * contraseña (APP_ACCOUNTANT_PASSWORD_HASH): ve todo y baja los Excel, pero no
 * importa, no re-concilia ni toca cruces o categorías.
 */
export type Role = "admin" | "contador";

export async function createSession(role: Role = "admin") {
  const token = await new SignJWT({ user: role === "admin" ? "leo" : "contador", role })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DURATION_SECONDS}s`)
    .sign(getSecret());

  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DURATION_SECONDS,
  });
}

export async function destroySession() {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}

export async function getRole(): Promise<Role | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret());
    // Las sesiones de antes de los roles no traen "role": eran de Leo.
    return payload.role === "contador" ? "contador" : "admin";
  } catch {
    return null;
  }
}

export async function getSession(): Promise<boolean> {
  return (await getRole()) !== null;
}

export async function isReadOnly(): Promise<boolean> {
  return (await getRole()) === "contador";
}

/**
 * Las server actions son endpoints POST públicos por debajo: el proxy ya los
 * filtra por cookie, pero cada action vuelve a verificar la sesión por su
 * cuenta para no depender de una sola capa (si mañana cambia el `matcher` del
 * proxy, las acciones que escriben en la base no quedan abiertas).
 */
export async function requireSession(): Promise<void> {
  if (!(await getSession())) throw new Error("No autorizado.");
}

/** Para todo lo que escribe en la base: el acceso del contador es de solo lectura. */
export async function requireAdmin(): Promise<void> {
  const role = await getRole();
  if (role === null) throw new Error("No autorizado.");
  if (role !== "admin") throw new Error("Este acceso es de solo lectura.");
}

export { COOKIE_NAME };
