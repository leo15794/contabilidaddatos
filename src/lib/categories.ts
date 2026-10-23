import { sql, type SQL } from "drizzle-orm";

/**
 * Facturas recibidas que todavía no tienen pago registrado (deuda abierta). No
 * son un error de conciliación: no hay un pago contra el cual cruzarlas. La
 * categoría las saca del "sin conciliar" y del denominador del % conciliado, y
 * las deja listadas con su total en el Dashboard (= cuentas por pagar).
 *
 * A diferencia de las otras categorías, el motor SIGUE considerando estas
 * facturas para conciliar: si el pago aparece (una transferencia, un resumen de
 * tarjeta que se carga después), se cruzan solas y la categoría se limpia
 * (ver `releasePendingPaymentCategory`).
 */
export const PENDING_PAYMENT_CATEGORY = "Pendientes de pago";

/** Facturas que el banco emite por sus propias comisiones: la plata ya figura (categorizada) en el extracto, no hay un pago individual que cruzar. */
export const BANK_INVOICES_CATEGORY = "Facturas de comisiones bancarias";
export const BANK_CUIT = "30500010084";

/**
 * Saca la categoría "Pendientes de pago" de lo que ya quedó conciliado, para que
 * deje de figurar como deuda abierta y vuelva a contar como un conciliado más.
 * Es idempotente: se llama al empezar y al terminar cada corrida del motor, y
 * después de confirmar o unir un match a mano.
 */
export async function releasePendingPaymentCategory(run: (query: SQL) => PromiseLike<unknown>) {
  await run(sql`
    update transactions set category = null
    where category = ${PENDING_PAYMENT_CATEGORY}
      and exists (
        select 1 from match_items mi join matches m on m.id = mi.match_id
        where mi.transaction_id = transactions.id and m.status in ('auto', 'confirmed', 'manual')
      )
  `);
}
