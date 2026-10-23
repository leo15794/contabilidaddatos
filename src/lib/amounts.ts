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
