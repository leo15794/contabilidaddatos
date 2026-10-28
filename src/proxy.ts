import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";

const COOKIE_NAME = "session";
// /api/tickets/ingest: pública porque la llama OpenWA (el gateway de WhatsApp
// self-hosted, corre aparte en un VPS), no un navegador con sesión — se
// protege con la firma HMAC de OpenWA (OPENWA_WEBHOOK_SECRET), ver
// src/app/api/tickets/ingest/route.ts.
const PUBLIC_PATHS = ["/login", "/api/tickets/ingest"];
const ADMIN_ONLY_PATHS = ["/import", "/importaciones", "/review", "/socios", "/usuarios"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const token = request.cookies.get(COOKIE_NAME)?.value;
  const secret = process.env.AUTH_SECRET;

  let authenticated = false;
  let readOnly = false;
  if (token && secret) {
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
      authenticated = true;
      readOnly = payload.role === "contador";
    } catch {
      authenticated = false;
    }
  }

  if (!authenticated) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("from", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // El contador (solo lectura) no entra a las pantallas que son para cargar o decidir.
  if (readOnly && ADMIN_ONLY_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/health).*)",
  ],
};
