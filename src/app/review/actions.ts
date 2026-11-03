"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { importBatches, matches, matchItems, transactions } from "@/db/schema";
import { requireAdmin, requireSession } from "@/lib/auth/session";
import { searchForManualMatch, type ManualSearchRow } from "@/lib/queries";
import { netAmount, parseAmountInput } from "@/lib/amounts";
import { releasePendingPaymentCategory } from "@/lib/categories";

const PAYMENT_SOURCES = new Set(["bank", "card", "cash", "ticket", "retention"]);

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
    const found = await tx
      .select({ id: transactions.id, source: transactions.source, amount: transactions.amount })
      .from(transactions)
      .where(inArray(transactions.id, ids));
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

    // Lo pagado contra lo facturado (neto de notas de crédito), como en Revisar sugerencias.
    const paid = found.filter((t) => PAYMENT_SOURCES.has(t.source)).reduce((acc, t) => acc + Math.abs(Number(t.amount)), 0);
    const billed = found.filter((t) => !PAYMENT_SOURCES.has(t.source)).reduce((acc, t) => acc + netAmount(t.source, t.amount), 0);
    const amountDiff = Math.abs(paid - billed);

    const [row] = await tx
      .insert(matches)
      .values({ strategy: "manual", status: "manual", confidence: 100, amountDiff: amountDiff.toFixed(2) })
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
export async function searchManualAction(input: {
  text: string;
  amount: string;
  margin: number;
  side?: "comprobantes" | "pagos";
}): Promise<ManualSearchRow[]> {
  await requireSession();
  const amount = parseAmountInput(input.amount);
  const margin = [0, 0.01, 0.05, 0.1].includes(input.margin) ? input.margin : 0;
  const side = input.side === "comprobantes" || input.side === "pagos" ? input.side : undefined;
  return searchForManualMatch({ text: input.text.slice(0, 100), amount, margin, side });
}

/**
 * "Pagada en efectivo": para la factura que se pagó en mano y no quedó en la
 * planilla de Gastos Socios. Crea el movimiento de efectivo por el total de
 * las facturas tildadas (como una fila de esa planilla: "Efectivo · <proveedor>",
 * cuenta "Efectivo · <quién pagó>") y lo cruza con ellas en el mismo paso.
 */
export async function markPaidInCashAction(
  transactionIds: number[],
  input: { date: string; payer: string; note: string },
): Promise<ManualMatchResult> {
  await requireAdmin();
  const ids = [...new Set(transactionIds.filter((id) => Number.isInteger(id)))];
  if (ids.length === 0) return { error: "Tildá al menos una factura." };
  const payer = input.payer.trim().slice(0, 60);
  if (!payer) return { error: "Poné quién pagó." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return { error: "La fecha no es válida." };
  const date = new Date(`${input.date}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return { error: "La fecha no es válida." };
  const note = input.note.trim().slice(0, 300);

  const result = await db.transaction(async (tx): Promise<ManualMatchResult> => {
    const docs = await tx.select().from(transactions).where(inArray(transactions.id, ids));
    if (docs.length !== ids.length) {
      return { error: "Alguna factura ya no existe. Actualizá la página e intentá de nuevo." };
    }
    if (docs.some((t) => t.source !== "afip_received" && t.source !== "afip_issued")) {
      return { error: "Solo se pueden marcar como pagadas en efectivo facturas y notas de crédito." };
    }
    if (new Set(docs.map((t) => t.source)).size > 1) {
      return { error: "No mezcles facturas de proveedores y de clientes en el mismo pago." };
    }
    const alreadyMatched = await tx
      .select({ id: matchItems.transactionId })
      .from(matchItems)
      .innerJoin(matches, eq(matches.id, matchItems.matchId))
      .where(and(inArray(matchItems.transactionId, ids), ne(matches.status, "rejected")));
    if (alreadyMatched.length > 0) {
      return { error: "Alguna de las facturas ya está conciliada o en revisión. Actualizá la página." };
    }

    const total = Math.round(docs.reduce((acc, t) => acc + netAmount(t.source, t.amount), 0) * 100) / 100;
    if (total <= 0) return { error: "El total de lo tildado tiene que ser mayor a cero." };
    // A un proveedor se le paga (egreso); un cliente nos paga (ingreso).
    const amount = docs[0].source === "afip_received" ? -total : total;
    const name = (docs[0].counterparty ?? "").replace(/^[\d.]+\s*-\s*/, "").trim() || "Sin identificar";

    const [batch] = await tx
      .insert(importBatches)
      .values({ source: "cash", filename: "Pagada en efectivo (cargado a mano)", accountRef: `Efectivo · ${payer}`, rowCount: 1 })
      .returning({ id: importBatches.id });
    const [cash] = await tx
      .insert(transactions)
      .values({
        batchId: batch.id,
        source: "cash",
        date,
        description: `Efectivo · ${name}`,
        amount: amount.toFixed(2),
        accountRef: `Efectivo · ${payer}`,
        counterparty: name,
        raw: { quien: payer, origen: "Pagada en efectivo (cargado a mano)", nota: note || null, facturas: ids },
      })
      .returning({ id: transactions.id });

    const [match] = await tx
      .insert(matches)
      .values({
        strategy: "manual",
        status: "manual",
        confidence: 100,
        amountDiff: "0",
        note: `Pagada en efectivo por ${payer}${note ? ` — ${note}` : ""}.`,
        resolvedAt: new Date(),
      })
      .returning({ id: matches.id });
    await tx.insert(matchItems).values([...ids, cash.id].map((transactionId) => ({ matchId: match.id, transactionId })));
    await tx.update(transactions).set({ category: null }).where(inArray(transactions.id, ids));
    return {};
  });

  await releasePendingPaymentCategory((q) => db.execute(q));
  revalidatePath("/review");
  revalidatePath("/dashboard");
  revalidatePath("/sin-conciliar/[fuente]", "page");
  return result;
}

/** Quiénes pagaron en efectivo hasta ahora, para sugerirlos en "Pagada en efectivo". */
export async function getCashPayersAction(): Promise<string[]> {
  await requireSession();
  const rows = await db
    .selectDistinct({ ref: transactions.accountRef })
    .from(transactions)
    .where(eq(transactions.source, "cash"));
  return [...new Set(rows.map((r) => (r.ref ?? "").replace(/^Efectivo\s*·\s*/, "").trim()).filter(Boolean))].sort();
}
