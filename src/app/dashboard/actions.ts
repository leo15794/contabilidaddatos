"use server";

import { revalidatePath } from "next/cache";
import { runMatchingEngine } from "@/lib/matching/engine";

export async function reconcileAction() {
  const result = await runMatchingEngine();
  revalidatePath("/dashboard");
  revalidatePath("/review");
  return result;
}
