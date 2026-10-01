/**
 * Movimientos bancarios que nunca deberían entrar al motor de conciliación,
 * ni como match automático ni como sugerencia para revisar: son "internos"
 * del banco (impuestos propios, comisiones, extracciones de efectivo,
 * transferencias entre cuentas del mismo titular), nunca el pago de una
 * factura ni un ingreso/egreso real contra un tercero. Si se dejan en el
 * pool, el matching fuzzy termina uniéndolos con facturas AFIP o tickets
 * solo porque el importe y la fecha caen cerca — una coincidencia de
 * números, no de operación real.
 *
 * Basado en causales/conceptos reales del homebanking de Banco Macro; si
 * aparece un nuevo tipo de movimiento interno que se esté matcheando mal,
 * se agrega acá.
 */
const NON_RECONCILABLE_PATTERNS: RegExp[] = [
  /tasa\s*gral/i, // DBCR ... TASA GRAL: impuesto al débito/crédito del propio banco
  /sircreb/i, // RET. ING. BRUTOS SIRCREB: retención de ingresos brutos
  /\bmismo\b/i, // transferencias/saldos entre cuentas del mismo titular ("MISMO TIT", "CCDO MISMO")
  /mantenimiento/i, // mantenimiento de cuenta/paquete
  /^imp\.?\s*afip/i, // pago de impuestos a AFIP (no corresponde a una factura puntual)
  /debito\s*fiscal\s*iva/i, // desglose de IVA sobre comisiones/gastos bancarios
  /^debito\s*iva/i,
  /comision/i, // comisiones bancarias (transferencias, mantenimiento, etc.)
  /^com\.?\s/i, // "COM RETIRO EFECTIVO...": abreviatura de comisión
  /extrac/i, // EXTRACCION / EXTRAC EFVO: retiros de efectivo, no son pagos a terceros
  /retiro\s*efectivo/i,
  /cajero\s*autom/i, // extracción por cajero automático
];

type MatchableTxn = { source: string; description: string };

export function isNonReconcilableBankMovement(t: MatchableTxn): boolean {
  if (t.source !== "bank") return false;
  return NON_RECONCILABLE_PATTERNS.some((re) => re.test(t.description));
}
