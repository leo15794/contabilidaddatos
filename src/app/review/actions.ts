"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { matches, matchItems } from "@/db/schema";

export async function resolveMatchAction(matchId: number, decision: "confirmed" | "rejected") {
  await db
    .update(matches)
    .set({ status: decision, resolvedAt: new Date() })
    .where(eq(matches.id, matchId));

  revalidatePath("/review");
  revalidatePath("/dashboard");
}

export async function createManualMatchAction(transactionIds: number[]) {
  if (transactionIds.length < 2) return;

  const [row] = await db
    .insert(matches)
    .values({ strategy: "manual", status: "manual", confidence: 100, amountDiff: "0" })
    .returning({ id: matches.id });

  await db.insert(matchItems).values(
    transactionIds.map((transactionId) => ({ matchId: row.id, transactionId })),
  );

  revalidatePath("/review");
  revalidatePath("/dashboard");
  // "page" en vez del path exacto: revalida /sin-conciliar/[fuente] para
  // cualquier fuente, no solo la que se estaba viendo cuando se unió a mano.
  revalidatePath("/sin-conciliar/[fuente]", "page");
}
