import { pairKey, type MatchSpec, type RejectedPairs, type StepResult, type Txn } from "./types";

/**
 * Un consumo de tarjeta que cubre VARIAS facturas: un carrito de compras (en
 * MercadoPago cada vendedor emite su propia factura) o una compra con facturas
 * separadas en el mismo comercio. El resumen trae un solo importe, el total, y las
 * facturas llegan por separado.
 *
 * Casos reales, todos exactos al centavo:
 *   MERPAGO*MERCADOLIBRE $106.365,60 = $21.775,00 (Vicario) + $84.590,60 (Soto);
 *   MERPAGO*INTEGRA $130.303,64 = $59.100 + $20.300 + $50.903,64;
 *   MERPAGO*MICROCHEAP $155.179 = $5.180 + $149.999 (las dos de Grupo Monaco).
 *
 * - De 2 a 4 facturas recibidas libres cuya suma cierra con el consumo (hasta $1 de
 *   diferencia) y emitidas cerca de la fecha del consumo (la tarjeta se cobra casi
 *   al instante; las facturas del mismo carrito salen el mismo día o a los pocos días).
 * - Si el consumo se puede armar de más de una forma no se adivina.
 * - Con 3 o más facturas, o con un total que no es redondo en miles, la suma exacta
 *   no se da por casualidad y se confirma sola; si no, queda como sugerencia.
 */
const MAX_DAYS = 5;
const MAX_SIZE = 4;
const MAX_CANDIDATES = 14;
const TOLERANCE = 1;
const MIN_CARD = 10000;
const DAY_MS = 24 * 60 * 60 * 1000;

function combinations<T>(items: T[], size: number, visit: (combo: T[]) => void) {
  const combo: T[] = [];
  const rec = (start: number) => {
    if (combo.length === size) {
      visit([...combo]);
      return;
    }
    for (let i = start; i < items.length; i++) {
      combo.push(items[i]);
      rec(i + 1);
      combo.pop();
    }
  };
  rec(0);
}

export function runCardMultiInvoice(pool: Txn[], rejected: RejectedPairs): StepResult {
  const cards = pool
    .filter((t) => t.source === "card" && Number(t.amount) < 0 && Math.abs(Number(t.amount)) >= MIN_CARD)
    .sort((a, b) => a.date.getTime() - b.date.getTime() || a.id - b.id);
  const invoices = pool.filter((t) => t.source === "afip_received" && Number(t.amount) < 0);

  const used = new Set<number>();
  const specs: MatchSpec[] = [];

  for (const card of cards) {
    if (used.has(card.id)) continue;
    const target = Math.abs(Number(card.amount));

    const candidates = invoices
      .filter(
        (inv) =>
          !used.has(inv.id) &&
          Math.abs(Number(inv.amount)) < target &&
          Math.abs(inv.date.getTime() - card.date.getTime()) <= MAX_DAYS * DAY_MS &&
          !rejected.has(pairKey(card.id, inv.id)),
      )
      .sort((a, b) => Math.abs(a.date.getTime() - card.date.getTime()) - Math.abs(b.date.getTime() - card.date.getTime()))
      .slice(0, MAX_CANDIDATES);

    // El tamaño más chico que cierra manda; si hay más de una forma de armarlo, no se adivina.
    let solutions: Txn[][] = [];
    for (let size = 2; size <= Math.min(MAX_SIZE, candidates.length); size++) {
      combinations(candidates, size, (combo) => {
        const sum = combo.reduce((acc, inv) => acc + Math.abs(Number(inv.amount)), 0);
        if (Math.abs(sum - target) <= TOLERANCE) solutions.push(combo);
      });
      if (solutions.length > 0) break;
    }
    if (solutions.length !== 1) {
      solutions = [];
      continue;
    }

    const combo = solutions[0];
    for (const inv of combo) used.add(inv.id);
    used.add(card.id);

    const round = target % 1000 === 0;
    const auto = combo.length >= 3 || !round;
    const sum = combo.reduce((acc, inv) => acc + Math.abs(Number(inv.amount)), 0);

    specs.push({
      strategy: "payment_group",
      status: auto ? "auto" : "pending",
      confidence: auto ? 88 : 70,
      amountDiff: Math.abs(sum - target),
      transactionIds: [card.id, ...combo.map((inv) => inv.id)],
      note: `Consumo de tarjeta que cubre ${combo.length} facturas separadas (compra con varias facturas): sus importes suman ${sum.toFixed(2)}${
        auto ? "." : " — total redondo, revisar."
      }`,
    });
  }

  return { specs, remaining: pool.filter((t) => !used.has(t.id)) };
}
