"use server";

import { revalidatePath } from "next/cache";
import { setTransactionsCategory } from "@/lib/queries";

/**
 * Categoriza a mano un conjunto de movimientos (ej. "Gastos operativos") —
 * para cargos que el banco cobra directo en el resumen de tarjeta (IVA,
 * sellos, comisiones, intereses, etc.) y que nunca van a tener una factura o
 * transferencia con la que cruzar. Una vez categorizado, el movimiento deja
 * de contar como "sin conciliar" en todos lados (Dashboard, Revisión,
 * Importaciones) sin necesidad de un match real.
 */
export async function categorizeTransactionsAction(transactionIds: number[], category: string, batchId: number) {
  const trimmed = category.trim();
  if (!trimmed || transactionIds.length === 0) return;

  await setTransactionsCategory(transactionIds, trimmed);

  revalidatePath(`/importaciones/${batchId}`);
  revalidatePath("/importaciones");
  revalidatePath("/dashboard");
  revalidatePath("/review");
}

/** Deshace la categorización — el movimiento vuelve a necesitar conciliación normal. */
export async function uncategorizeTransactionsAction(transactionIds: number[], batchId: number) {
  if (transactionIds.length === 0) return;

  await setTransactionsCategory(transactionIds, null);

  revalidatePath(`/importaciones/${batchId}`);
  revalidatePath("/importaciones");
  revalidatePath("/dashboard");
  revalidatePath("/review");
}
