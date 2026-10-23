import { pairKey, type MatchSpec, type RejectedPairs, type StepResult, type Txn } from "./types";

/**
 * Factura pagada en parte con tarjeta y el resto de otra forma (efectivo, otra
 * tarjeta): el consumo es MENOR que la factura y la diferencia es un importe
 * redondo. Ejemplos de la planilla: factura de Santos Costa de $84.506,93 =
 * $59.506,92 de tarjeta + $25.000 más; Howard Johnson $214.689,65 contra un
 * consumo de $204.689,65 (faltan $10.000 justos).
 *
 * - El resto tiene que ser múltiplo de $500 (con un peso de tolerancia por los
 *   centavos de la factura), de al menos $1.000 y hasta el 60 % de la factura.
 * - Misma ventana de fecha que el cruce exacto de tarjeta contra factura.
 * - Si el consumo (o la factura) tiene otra candidata, no se adivina.
 * - Solo sugerencia: un resto redondo puede ser casualidad.
 */
const MAX_DAYS = 2;
const REST_MULTIPLE = 500;
const REST_MIN = 1000;
const REST_MAX_SHARE = 0.6;
const REST_TOLERANCE = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

export function runPartialCardPayments(pool: Txn[], rejected: RejectedPairs): StepResult {
  const cards = pool.filter((t) => t.source === "card" && Number(t.amount) < 0);
  const invoices = pool.filter((t) => t.source === "afip_received" && Number(t.amount) < 0);

  const pairs: { card: Txn; inv: Txn; rest: number }[] = [];
  for (const card of cards) {
    const paid = Math.abs(Number(card.amount));
    for (const inv of invoices) {
      const total = Math.abs(Number(inv.amount));
      const rest = total - paid;
      if (rest < REST_MIN || rest > total * REST_MAX_SHARE) continue;
      const offset = rest % REST_MULTIPLE;
      if (Math.min(offset, REST_MULTIPLE - offset) > REST_TOLERANCE) continue;
      if (Math.abs(card.date.getTime() - inv.date.getTime()) > MAX_DAYS * DAY_MS) continue;
      if (rejected.has(pairKey(card.id, inv.id))) continue;
      pairs.push({ card, inv, rest });
    }
  }

  const cardCount = new Map<number, number>();
  const invCount = new Map<number, number>();
  for (const p of pairs) {
    cardCount.set(p.card.id, (cardCount.get(p.card.id) ?? 0) + 1);
    invCount.set(p.inv.id, (invCount.get(p.inv.id) ?? 0) + 1);
  }

  const used = new Set<number>();
  const specs: MatchSpec[] = [];
  for (const p of pairs) {
    if (cardCount.get(p.card.id) !== 1 || invCount.get(p.inv.id) !== 1) continue;
    used.add(p.card.id);
    used.add(p.inv.id);
    specs.push({
      strategy: "fuzzy",
      status: "pending",
      confidence: 60,
      amountDiff: p.rest,
      transactionIds: [p.card.id, p.inv.id],
      note: `Sugerencia automática — el consumo de tarjeta es menor que la factura por ${p.rest.toFixed(2)}, un importe redondo: probable pago parcial (el resto en efectivo u otro medio). Misma fecha y única candidata. Revisar.`,
    });
  }

  return { specs, remaining: pool.filter((t) => !used.has(t.id)) };
}
