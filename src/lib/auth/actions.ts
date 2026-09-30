"use server";

import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { createSession, destroySession } from "./session";

export async function loginAction(
  _prevState: { error?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string }> {
  const password = String(formData.get("password") ?? "");
  const from = String(formData.get("from") ?? "/dashboard");

  const hash = process.env.APP_PASSWORD_HASH;
  if (!hash) {
    return {
      error:
        "Falta configurar APP_PASSWORD_HASH en las variables de entorno del servidor.",
    };
  }

  const valid = await bcrypt.compare(password, hash);
  if (!valid) {
    return { error: "Contraseña incorrecta." };
  }

  await createSession();
  redirect(from || "/dashboard");
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}
