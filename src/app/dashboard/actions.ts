"use server";

import { revalidatePath } from "next/cache";
import { runMatchingEngine } from "@/lib/matching/engine";
import { requireAdmin } from "@/lib/auth/session";

export async function reconcileAction() {
  await requireAdmin();
  const result = await runMatchingEngine();
  revalidatePath("/dashboard");
  revalidatePath("/review");
  return result;
}
