"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { matches, matchItems, transactions } from "@/db/schema";
import { requireAdmin, requireSession } from "@/lib/auth/session";
import { searchForManualMatch, type ManualSearchRow } from "@/lib/queries";
import { releasePendingPaymentCategory } from "@/lib/categories";

export async function resolveMatchAction(matchId: number, decision: "confirmed" | "rejected") {
  await requireAdmin();
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
  await requireAdmin();
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
    // Una categoría marca lo que NO tiene contraparte; si se unió a mano, la tiene
    // (ej. una transferencia a un tercero marcada por error como cuentas propias).
    await tx.update(transactions).set({ category: null }).where(inArray(transactions.id, ids));
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

/** Confirmar o rechazar varias sugerencias de una vez (ej. todas las de confianza alta). */
export async function resolveManyAction(matchIds: number[], decision: "confirmed" | "rejected") {
  await requireAdmin();
  const ids = [...new Set(matchIds.filter((id) => Number.isInteger(id)))];
  if (ids.length === 0) return;
  // Solo las que siguen pendientes: si otra pestaña ya resolvió alguna, no se pisa.
  await db
    .update(matches)
    .set({ status: decision, resolvedAt: new Date() })
    .where(and(inArray(matches.id, ids), eq(matches.status, "pending")));
  await releasePendingPaymentCategory((q) => db.execute(q));
  revalidatePath("/review");
  revalidatePath("/dashboard");
}

/** Buscador de "Unir a mano": facturas y pagos sin conciliar por texto y/o importe. */
export async function searchManualAction(input: { text: string; amount: string; margin: number }): Promise<ManualSearchRow[]> {
  await requireSession();
  const amount = parseAmount(input.amount);
  const margin = [0, 0.01, 0.05, 0.1].includes(input.margin) ? input.margin : 0;
  return searchForManualMatch({ text: input.text.slice(0, 100), amount, margin });
}

/**
 * Importe como lo escribe la gente: "1.254.500,50", "1254500.5", "$ 74.500".
 * Con coma, la coma es el decimal; sin coma, un punto seguido de 3 cifras es
 * de miles ("74.500") y si no, decimal ("74500.04").
 */
function parseAmount(raw: string): number | undefined {
  let s = raw.replace(/[$\s]/g, "");
  if (!s) return undefined;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  const n = Math.abs(Number(s));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
