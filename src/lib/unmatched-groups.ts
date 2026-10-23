import { extractCuits } from "@/lib/matching/cuit";
import type { transactions } from "@/db/schema";

type Txn = typeof transactions.$inferSelect;

export type TxnGroup = {
  /** Identificador estable del grupo (va en la URL para filtrar). */
  key: string;
  /** Nombre legible: proveedor, comercio o destinatario. */
  label: string;
  /** CUIT cuando se pudo leer, para mostrarlo al lado del nombre. */
  cuit: string | null;
  count: number;
  /** Suma en valor absoluto (lo que importa para saber "cuánta plata" es). */
  total: number;
  first: Date;
  last: Date;
  rows: Txn[];
};

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();

// "MERPAGO*ALEMANA 4521", "ESSO 3030", "APPYPF 01040 COMBUST" -> sin el número final
// que cambia en cada consumo (comprobante, sucursal), así los consumos del mismo
// comercio caen en un solo grupo.
const stripTail = (s: string) => norm(s).replace(/[\d\s*#:-]+$/, "").trim();

/**
 * A qué grupo pertenece un movimiento sin match:
 * - Comprobantes AFIP: por CUIT del proveedor/cliente (el nombre puede venir
 *   escrito distinto entre comprobantes; el CUIT no cambia).
 * - Banco: por el CUIT que trae pegado en la descripción, o por la descripción
 *   sin números si no tiene.
 * - Tarjeta y tickets: por comercio.
 */
export function groupOf(t: Txn): { key: string; label: string; cuit: string | null } {
  if (t.source === "afip_issued" || t.source === "afip_received") {
    const cuit = extractCuits(t.counterparty)[0] ?? null;
    const name = (t.counterparty ?? "").replace(/^[\d.]+\s*-\s*/, "").trim() || "Sin identificar";
    return { key: cuit ? `cuit:${cuit}` : `n:${norm(name)}`, label: name, cuit };
  }

  if (t.source === "bank") {
    const cuit = extractCuits(t.description)[0] ?? null;
    if (cuit) {
      // Se saca primero el código de operación ("67REZ8NPM1X3POZ1N4KVGO", el
      // número de transferencia) y después los números sueltos, para que quede
      // solo el texto descriptivo ("TEF DATANET PR BOLDT SG DIGTAL UT").
      const cleaned = norm(t.description)
        .replace(/[A-Z0-9]{12,}/g, " ")
        .replace(/[\d:-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40);
      return { key: `cuit:${cuit}`, label: cleaned.length > 6 ? cleaned : "Transferencia", cuit };
    }
    const base = stripTail(t.description) || norm(t.description);
    return { key: `d:${base}`, label: base || "(sin descripción)", cuit: null };
  }

  const base = stripTail(t.description) || norm(t.description);
  return { key: `m:${base}`, label: base || "(sin descripción)", cuit: null };
}

/** Agrupa y ordena por plata (la más grande primero). */
export function groupTransactions(rows: Txn[]): TxnGroup[] {
  const groups = new Map<string, TxnGroup>();

  for (const t of rows) {
    const g = groupOf(t);
    const amount = Math.abs(Number(t.amount));
    const existing = groups.get(g.key);
    if (existing) {
      existing.count++;
      existing.total += amount;
      if (t.date < existing.first) existing.first = t.date;
      if (t.date > existing.last) existing.last = t.date;
      existing.rows.push(t);
      // Para el banco, el nombre más largo suele ser el más descriptivo.
      if (g.label.length > existing.label.length) existing.label = g.label;
    } else {
      groups.set(g.key, { ...g, count: 1, total: amount, first: t.date, last: t.date, rows: [t] });
    }
  }

  return [...groups.values()].sort((a, b) => b.total - a.total);
}
