import { pairKey, type MatchSpec, type RejectedPairs, type StepResult, type Txn } from "./types";

/**
 * Consumo de tarjeta contra factura recibida cuando el NOMBRE del comercio
 * coincide con el del proveedor, aunque el importe no sea idéntico o pasen unos
 * días más que el límite del cruce exacto.
 *
 * Casos reales: `MERPAGO*GRUPOVINDUR` contra GRUPO VINDUR S.A. (mismo importe,
 * 3 días); `MERPAGO*AQUAHOME` contra AQUAHOME S.A. (2,9 % de diferencia). El cruce
 * exacto exige 2 días y $1 porque sin nombre un importe parecido no dice nada
 * (ese fue el bug de las facturas de BOLDT contra consumos en YPF); con el nombre
 * en común se puede ser más flexible, pero igual queda como sugerencia.
 *
 * - Hasta MAX_DAYS de distancia y MAX_PCT de diferencia de importe.
 * - Si el consumo tiene más de una factura candidata (o al revés) no se adivina.
 */
const MAX_DAYS = 5;
const MAX_PCT = 0.03;
const DAY_MS = 24 * 60 * 60 * 1000;

// Palabras que no identifican a un comercio ni a un proveedor.
const GENERIC = new Set([
  "merpago", "mercadopago", "mercado", "pago", "pagos", "compra", "visa", "master", "mastercard", "pesos", "debito",
  "sociedad", "anonima", "responsabilidad", "limitada", "servicios", "argentina", "empresa", "comercial", "grupo",
  "industrial", "distribuidora", "compania", "estacion", "estaciones", "combustibles", "combustible",
]);

function squash(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function words(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 5 && !GENERIC.has(w));
}

/** ¿El nombre del comercio del resumen aparece en la razón social del proveedor (o al revés)? */
export function merchantMatchesSupplier(cardDescription: string, counterparty: string | null): boolean {
  const supplier = (counterparty ?? "").replace(/^[\d.\s-]+/, "");
  const supplierSquashed = squash(supplier);
  const cardSquashed = squash(cardDescription);
  if (!supplierSquashed || !cardSquashed) return false;
  // "MERPAGO*GRUPOVINDUR" -> la palabra pegada "grupovindur" contenida en "grupovindursa".
  if (words(cardDescription).some((w) => supplierSquashed.includes(w))) return true;
  // O al revés: una palabra distintiva de la razón social dentro del texto del comercio.
  return words(supplier).some((w) => cardSquashed.includes(w));
}

export function runCardNameMatches(pool: Txn[], rejected: RejectedPairs): StepResult {
  const cards = pool.filter((t) => t.source === "card" && Number(t.amount) < 0);
  const invoices = pool.filter((t) => t.source === "afip_received" && Number(t.amount) < 0);

  // Pares plausibles; se aceptan solo los que son únicos de ambos lados.
  const pairs: { card: Txn; inv: Txn; pct: number }[] = [];
  for (const card of cards) {
    const amount = Math.abs(Number(card.amount));
    for (const inv of invoices) {
      if (rejected.has(pairKey(card.id, inv.id))) continue;
      if (Math.abs(card.date.getTime() - inv.date.getTime()) > MAX_DAYS * DAY_MS) continue;
      const pct = Math.abs(amount - Math.abs(Number(inv.amount))) / Math.max(amount, 0.01);
      if (pct > MAX_PCT) continue;
      if (!merchantMatchesSupplier(card.description, inv.counterparty)) continue;
      pairs.push({ card, inv, pct });
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
    const diff = Math.abs(Math.abs(Number(p.card.amount)) - Math.abs(Number(p.inv.amount)));
    specs.push({
      strategy: "fuzzy",
      status: "pending",
      confidence: Math.round(80 - p.pct * 1000), // 80 si coincide el importe, ~50 en el límite del 3 %
      amountDiff: diff,
      transactionIds: [p.card.id, p.inv.id],
      note: `Sugerencia automática — el comercio de la tarjeta coincide con el proveedor por nombre (diferencia de importe ${diff.toFixed(2)}, ${(p.pct * 100).toFixed(1)} %). Revisar antes de confirmar.`,
    });
  }

  return { specs, remaining: pool.filter((t) => !used.has(t.id)) };
}
