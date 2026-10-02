"use server";

import { revalidatePath } from "next/cache";
import { createPartner, deletePartner, monthKeyToDate, setPartnerBalance } from "@/lib/partners";

export type PartnerFormState = { error?: string; success?: string };

/** Crea un socio nuevo. Sus gastos de tarjeta se empiezan a detectar solos en cuanto el nombre coincida con un titular de algún resumen (ver `belongsToPartner` en `src/lib/partners.ts`). */
export async function createPartnerAction(
  _prev: PartnerFormState | undefined,
  formData: FormData,
): Promise<PartnerFormState> {
  const name = String(formData.get("name") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();

  if (!name) return { error: "Falta el nombre del socio." };

  await createPartner(name, phone || null);

  revalidatePath("/socios");
  return { success: `Agregado "${name}".` };
}

export async function deletePartnerAction(partnerId: number) {
  await deletePartner(partnerId);
  revalidatePath("/socios");
}

/** Carga/actualiza el saldo que se le asigna a un socio para un mes puntual. */
export async function setPartnerBalanceAction(
  _prev: PartnerFormState | undefined,
  formData: FormData,
): Promise<PartnerFormState> {
  const partnerId = Number(formData.get("partnerId"));
  const monthKey = String(formData.get("month") ?? "");
  const amountRaw = String(formData.get("amount") ?? "").replace(",", ".");
  const amount = Number(amountRaw);

  if (!partnerId || !monthKey) return { error: "Faltan datos." };
  if (!Number.isFinite(amount) || amount < 0) return { error: "El monto no es válido." };

  await setPartnerBalance(partnerId, monthKeyToDate(monthKey), amount);

  revalidatePath(`/socios/${partnerId}`);
  revalidatePath("/socios");
  return { success: "Saldo actualizado." };
}
