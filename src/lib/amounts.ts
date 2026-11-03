/**
 * Importe de un movimiento "en sentido de la deuda".
 *
 * En la base los comprobantes de AFIP ya vienen con signo (ver `afip-csv.ts`):
 * factura emitida = positivo, factura recibida = negativo, y la nota de
 * crédito lleva el signo OPUESTO a la factura (emitida = negativo, recibida =
 * positivo). Para una cuenta corriente lo que importa es cuánto se debe, así
 * que se da vuelta el signo de las recibidas: toda factura suma y toda nota de
 * crédito RESTA, de clientes y de proveedores. Antes se usaba el valor
 * absoluto y una nota de crédito de $26.000 se sumaba como una factura.
 *
 * Para banco, tarjeta y tickets (flujos de plata, no deuda) se devuelve el
 * valor absoluto, como siempre.
 */
export function netAmount(source: string, amount: number | string): number {
  const n = Number(amount);
  if (source === "afip_issued") return n;
  if (source === "afip_received") return -n;
  return Math.abs(n);
}

export function isCreditNote(description: string): boolean {
  return /nota\s*de\s*cr[eé]dito/i.test(description);
}

/**
 * Importe como lo escribe la gente en un buscador: "1.254.500,50",
 * "1254500.5", "$ 74.500". Con coma, la coma es el decimal; sin coma, un punto
 * seguido de 3 cifras es de miles ("74.500") y si no, decimal ("74500.04").
 * Devuelve el valor absoluto, o undefined si no es un importe.
 */
export function parseAmountInput(raw: string): number | undefined {
  let s = raw.replace(/[$\s]/g, "");
  if (!s) return undefined;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  const n = Math.abs(Number(s));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
