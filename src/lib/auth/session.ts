import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appUsers } from "@/db/schema";

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
 * "admin": hace todo. "contador": solo lectura, ve todo y baja los Excel, pero
 * no importa, no re-concilia ni toca cruces, categorías, socios ni usuarios.
 */
export type Role = "admin" | "contador";

export type SessionInfo = {
  /** 0 = entró con la llave de emergencia (APP_PASSWORD_HASH de Vercel), sin usuario en la base. */
  userId: number;
  username: string;
  name: string;
  role: Role;
  mustChangePassword: boolean;
};

export async function createSession(user: { userId: number; username: string; role: Role }) {
  const token = await new SignJWT({ uid: user.userId, user: user.username, role: user.role })
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

/**
 * Quién está adentro. Para un usuario de la base se relee su fila en cada
 * pedido: si lo desactivaron o le cambiaron el rol, vale desde ese momento, sin
 * esperar a que venza la cookie.
 */
export async function getSessionInfo(): Promise<SessionInfo | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return null;

  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, getSecret()));
  } catch {
    return null;
  }

  const userId = typeof payload.uid === "number" ? payload.uid : 0;
  if (userId > 0) {
    const [user] = await db.select().from(appUsers).where(eq(appUsers.id, userId));
    if (!user || !user.active) return null;
    return {
      userId: user.id,
      username: user.username,
      name: user.name,
      role: user.role === "admin" ? "admin" : "contador",
      mustChangePassword: user.mustChangePassword,
    };
  }

  // Llave de emergencia (o sesión de antes de los usuarios): siempre administrador.
  return { userId: 0, username: "admin", name: "Administrador", role: "admin", mustChangePassword: false };
}

export async function getRole(): Promise<Role | null> {
  return (await getSessionInfo())?.role ?? null;
}

export async function getSession(): Promise<boolean> {
  return (await getSessionInfo()) !== null;
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
export async function requireSession(): Promise<SessionInfo> {
  const info = await getSessionInfo();
  if (!info) throw new Error("No autorizado.");
  return info;
}

/** Para todo lo que escribe en la base: el acceso del contador es de solo lectura. */
export async function requireAdmin(): Promise<SessionInfo> {
  const info = await requireSession();
  if (info.role !== "admin") throw new Error("Este acceso es de solo lectura.");
  return info;
}

export { COOKIE_NAME };
