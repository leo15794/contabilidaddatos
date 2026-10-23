"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { matches, matchItems, transactions } from "@/db/schema";
import { requireSession } from "@/lib/auth/session";
import { releasePendingPaymentCategory } from "@/lib/categories";

export async function resolveMatchAction(matchId: number, decision: "confirmed" | "rejected") {
  await requireSession();
  await db
    .update(matches)
    .set({ status: decision, resolvedAt: new Date() })
    .where(eq(matches.id, matchId));

  // Una factura "Pendiente de pago" que se acaba de confirmar deja de ser deuda abierta.
  await releasePendingPaymentCategory((q) => db.execute(q));

  revalidatePath("/review");
  revalidatePath("/dashboard");
}

export type ManualMatchResult = { error?: string };

export async function createManualMatchAction(transactionIds: number[]): Promise<ManualMatchResult> {
  await requireSession();
  // Los ids vienen del cliente: se limpian y se validan contra la base antes de
  // crear nada (antes se insertaba cualquier cosa, y un id repetido o ya
  // conciliado rompía la clave primaria o dejaba un movimiento en dos matches).
  const ids = [...new Set(transactionIds.filter((id) => Number.isInteger(id)))];
  if (ids.length < 2) return { error: "Elegí al menos dos movimientos distintos." };

  const result = await db.transaction(async (tx): Promise<ManualMatchResult> => {
    const found = await tx.select({ id: transactions.id }).from(transactions).where(inArray(transactions.id, ids));
    if (found.length !== ids.length) {
      return { error: "Algún movimiento ya no existe. Actualizá la página e intentá de nuevo." };
    }

    const alreadyMatched = await tx
      .select({ id: matchItems.transactionId })
      .from(matchItems)
      .innerJoin(matches, eq(matches.id, matchItems.matchId))
      .where(and(inArray(matchItems.transactionId, ids), ne(matches.status, "rejected")));
    if (alreadyMatched.length > 0) {
      return {
        error: `${new Set(alreadyMatched.map((r) => r.id)).size} de los movimientos ya están conciliados o en revisión. Actualizá la página.`,
      };
    }

    const [row] = await tx
      .insert(matches)
      .values({ strategy: "manual", status: "manual", confidence: 100, amountDiff: "0" })
      .returning({ id: matches.id });

    await tx.insert(matchItems).values(ids.map((transactionId) => ({ matchId: row.id, transactionId })));
    return {};
  });

  revalidatePath("/review");
  await releasePendingPaymentCategory((q) => db.execute(q));

  revalidatePath("/dashboard");
  // "page" en vez del path exacto: revalida /sin-conciliar/[fuente] para
  // cualquier fuente, no solo la que se estaba viendo cuando se unió a mano.
  revalidatePath("/sin-conciliar/[fuente]", "page");

  return result;
}
