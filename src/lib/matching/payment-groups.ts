import { extractCuits } from "./cuit";
import { pairKey, type MatchSpec, type RejectedPairs, type StepResult, type Txn } from "./types";

/**
 * Pagos sin beneficiario: una transferencia del banco que NO dice a quién se
 * pagó (las "Transf. MacrOnline" solo traen el importe y un número de
 * referencia) contra UNA o VARIAS facturas recibidas del MISMO proveedor cuya
 * suma da exactamente ese importe.
 *
 * Ejemplos reales: una transferencia de $3.001.526 pagó dos facturas de
 * Digiboost del mismo día ($2.420.000 + $581.526); otra de $1.703.884 pagó dos
 * de Nosis ($831.568,80 + $872.315,20); una de $133.100 pagó dos de $66.550 de
 * Enfoque Profesional. El motor 1 a 1 no las une (la suma no es ningún importe
 * individual) y el de CUIT tampoco (la descripción no trae CUIT).
 *
 * - Todas las facturas del grupo tienen que ser del mismo CUIT: ese es el
 *   resto de evidencia que reemplaza al beneficiario que falta.
 * - La suma tiene que cerrar al centavo.
 * - Las facturas se pagan después de emitirse: hasta LOOKBACK_DAYS antes del pago.
 * - Si el mismo importe lo pueden cubrir proveedores distintos, se descarta por
 *   ambiguo; si lo cubre un solo proveedor con varias facturas iguales (ej.
 *   Digiboost mensual por $544.500) se toma la más vieja (se pagan en orden).
 * - Un importe redondo en miles (2.500.000) coincide por casualidad más fácil
 *   que uno con centavos o cifras sueltas, así que solo se auto-confirma el que
 *   no es redondo; el redondo queda como sugerencia para revisar.
 */
const MAX_GROUP_SIZE = 4;
const LOOKBACK_DAYS = 120;
const LOOKAHEAD_DAYS = 5;
const MAX_DOCS_PER_SUPPLIER = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

type Solution = { cuit: string; docs: Txn[] };

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

export function runPaymentGroups(
  pool: Txn[],
  opts: { amountTolerance: number },
  rejected: RejectedPairs,
): StepResult {
  const used = new Set<number>();
  const specs: MatchSpec[] = [];

  // Facturas recibidas libres (importe negativo), por CUIT.
  const docsByCuit = new Map<string, Txn[]>();
  for (const t of pool) {
    if (t.source !== "afip_received" || Number(t.amount) >= 0) continue;
    const cuit = extractCuits(t.counterparty)[0];
    if (!cuit) continue;
    const list = docsByCuit.get(cuit);
    if (list) list.push(t);
    else docsByCuit.set(cuit, [t]);
  }

  // Pagos del banco (importe negativo). Los que ya traen el CUIT de un proveedor
  // con facturas los resuelve la estrategia por CUIT; acá solo entran los que
  // no se pudieron atribuir.
  const payments = pool
    .filter((t) => {
      if (t.source !== "bank" || Number(t.amount) >= 0) return false;
      return !extractCuits(`${t.description} ${t.counterparty ?? ""}`).some((c) => docsByCuit.has(c));
    })
    .sort((a, b) => a.date.getTime() - b.date.getTime() || a.id - b.id);

  for (const p of payments) {
    const pAmount = Number(p.amount);
    const pTime = p.date.getTime();

    // Mínimo tamaño de grupo para el que haya alguna solución.
    let best: Solution[] = [];

    for (const [cuit, docs] of docsByCuit) {
      const candidates = docs
        .filter(
          (d) =>
            !used.has(d.id) &&
            !rejected.has(pairKey(p.id, d.id)) &&
            d.date.getTime() >= pTime - LOOKBACK_DAYS * DAY_MS &&
            d.date.getTime() <= pTime + LOOKAHEAD_DAYS * DAY_MS &&
            Math.abs(Number(d.amount)) <= Math.abs(pAmount) + opts.amountTolerance,
        )
        // Las más recientes primero y tope por proveedor, para acotar las combinaciones.
        .sort((a, b) => b.date.getTime() - a.date.getTime() || b.id - a.id)
        .slice(0, MAX_DOCS_PER_SUPPLIER);

      for (let size = 1; size <= Math.min(MAX_GROUP_SIZE, candidates.length); size++) {
        if (best.length > 0 && best[0].docs.length < size) break; // ya hay solución más chica
        combinations(candidates, size, (combo) => {
          const sum = combo.reduce((acc, d) => acc + Number(d.amount), 0);
          if (Math.abs(sum - pAmount) > opts.amountTolerance) return;
          if (best.length > 0 && best[0].docs.length > size) best = [];
          best.push({ cuit, docs: combo });
        });
      }
    }

    if (best.length === 0) continue;

    // Ambigüedad entre proveedores distintos: no se adivina.
    if (new Set(best.map((s) => s.cuit)).size > 1) continue;

    // Un solo proveedor (varias facturas iguales posibles): la que se emitió
    // primero, porque se pagan en orden.
    // Se comparan las fechas ordenadas de cada combinación (la más vieja gana, y
    // en empate la que tiene las siguientes más viejas).
    const datesOf = (s: Solution) => s.docs.map((d) => d.date.getTime()).sort((x, y) => x - y);
    const chosen = best.slice().sort((a, b) => {
      const da = datesOf(a);
      const db = datesOf(b);
      for (let i = 0; i < Math.min(da.length, db.length); i++) {
        if (da[i] !== db[i]) return da[i] - db[i];
      }
      return 0;
    })[0];

    const size = chosen.docs.length;
    const isRound = Math.abs(pAmount) % 1000 === 0;
    const auto = size >= 2 && !isRound;

    for (const d of chosen.docs) used.add(d.id);
    used.add(p.id);

    const first = new Date(Math.min(...chosen.docs.map((d) => d.date.getTime())));
    const last = new Date(Math.max(...chosen.docs.map((d) => d.date.getTime())));
    const range = first.getTime() === last.getTime() ? "" : ` (emitidas entre el ${first.toLocaleDateString("es-AR", { timeZone: "UTC" })} y el ${last.toLocaleDateString("es-AR", { timeZone: "UTC" })})`;

    specs.push({
      strategy: "payment_group",
      status: auto ? "auto" : "pending",
      confidence: auto ? 90 : size >= 2 ? 80 : 70,
      amountDiff: Math.abs(chosen.docs.reduce((acc, d) => acc + Number(d.amount), 0) - pAmount),
      transactionIds: [p.id, ...chosen.docs.map((d) => d.id)],
      note: `Transferencia sin beneficiario que cierra exacto con ${size} factura${size > 1 ? "s" : ""} del mismo proveedor (CUIT ${chosen.cuit})${range}${
        auto ? "." : size === 1 ? " — coincide solo el importe, revisar que sea ese proveedor." : " — importe redondo, revisar."
      }`,
    });
  }

  return { specs, remaining: pool.filter((t) => !used.has(t.id)) };
}
