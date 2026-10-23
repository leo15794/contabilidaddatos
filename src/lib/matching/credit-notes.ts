import { extractCuits } from "./cuit";
import { pairKey, type MatchSpec, type RejectedPairs, type StepResult, type Txn } from "./types";

/**
 * Anulaciones: una factura y la nota de crédito del MISMO proveedor/cliente
 * por exactamente el mismo importe se cancelan entre sí — no hay pago que
 * esperar ni cobro que cruzar. Sin este paso quedaban las dos libres para
 * siempre (ej. una factura de $145 M y su nota de crédito, o la factura de
 * Boldt de $7,5 M anulada 6 días después), sumando plata "sin conciliar" que
 * en realidad es cero.
 *
 * Solo cruza comprobantes de la MISMA fuente (emitidas con emitidas, recibidas
 * con recibidas), con el mismo CUIT, importes opuestos al centavo y hasta
 * MAX_DAYS de diferencia. Si hay varias facturas del mismo importe se elige la
 * más cercana en fecha a la nota de crédito (ej. dos facturas de $145,15 M y
 * una sola nota: se anula la más próxima, la otra sigue siendo un gasto real).
 */
const MAX_DAYS = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
const CREDIT_NOTE = /nota\s*de\s*cr[eé]dito/i;

const isAfip = (t: Txn) => t.source === "afip_issued" || t.source === "afip_received";

export function runCreditNotes(pool: Txn[], opts: { amountTolerance: number }, rejected: RejectedPairs): StepResult {
  const used = new Set<number>();
  const specs: MatchSpec[] = [];

  const invoicesByKey = new Map<string, Txn[]>();
  const notes: Txn[] = [];

  for (const t of pool) {
    if (!isAfip(t)) continue;
    const cuit = extractCuits(t.counterparty)[0];
    if (!cuit) continue;
    if (CREDIT_NOTE.test(t.description)) {
      notes.push(t);
    } else {
      const key = `${t.source}:${cuit}`;
      const list = invoicesByKey.get(key);
      if (list) list.push(t);
      else invoicesByKey.set(key, [t]);
    }
  }

  notes.sort((a, b) => a.date.getTime() - b.date.getTime() || a.id - b.id);

  for (const note of notes) {
    const cuit = extractCuits(note.counterparty)[0];
    const candidates = (invoicesByKey.get(`${note.source}:${cuit}`) ?? []).filter(
      (inv) =>
        !used.has(inv.id) &&
        !rejected.has(pairKey(inv.id, note.id)) &&
        Math.abs(Number(inv.amount) + Number(note.amount)) <= opts.amountTolerance &&
        Math.abs(inv.date.getTime() - note.date.getTime()) <= MAX_DAYS * DAY_MS,
    );
    if (candidates.length === 0) continue;

    // La factura más cercana en fecha a la nota; en empate, la más vieja.
    candidates.sort(
      (a, b) =>
        Math.abs(a.date.getTime() - note.date.getTime()) - Math.abs(b.date.getTime() - note.date.getTime()) ||
        a.date.getTime() - b.date.getTime(),
    );
    const invoice = candidates[0];
    const days = Math.round(Math.abs(invoice.date.getTime() - note.date.getTime()) / DAY_MS);

    used.add(invoice.id);
    used.add(note.id);
    specs.push({
      strategy: "credit_note",
      status: "auto",
      confidence: 90,
      amountDiff: Math.abs(Number(invoice.amount) + Number(note.amount)),
      transactionIds: [invoice.id, note.id],
      note: `Factura anulada por nota de crédito del mismo importe (${days} día${days === 1 ? "" : "s"} de diferencia) — se cancelan entre sí, no hay pago pendiente.`,
    });
  }

  return { specs, remaining: pool.filter((t) => !used.has(t.id)) };
}
