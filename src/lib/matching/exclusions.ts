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
// Agrupados por categoría — además de servir para excluir del motor (abajo),
// esto permite categorizar automáticamente estos movimientos al importar
// (ver `detectBankFeeCategory`, usado desde `parsers/bank-csv.ts`) para que
// no queden eternamente como "sin conciliar" en el Dashboard/Importaciones:
// nunca iban a conciliar nada, así que categorizados se limpian solos del
// historial en vez de haber que marcarlos a mano uno por uno.
//
// OJO: estos mismos grupos están duplicados en
// `scripts/categorize-bank-fees.mjs` (ese script es un .mjs plano para poder
// correrlo con `node` directo, sin pasar por el build de Next, así que no
// puede importar este archivo .ts) — si se agrega un patrón nuevo acá, hay
// que agregarlo ahí también para que el catch-up manual y la categorización
// automática de las próximas importaciones coincidan.
const NON_RECONCILABLE_GROUPS: { category: string; patterns: RegExp[] }[] = [
  {
    category: "Impuestos y comisiones bancarias",
    patterns: [
      /tasa\s*gral/i, // DBCR ... TASA GRAL: impuesto al débito/crédito del propio banco
      /sircreb/i, // RET. ING. BRUTOS SIRCREB: retención de ingresos brutos
      /retenci/i, // cualquier otra retención que el banco aplica de oficio (IIBB, Ganancias, etc.), no es un pago a un tercero
      /mantenimiento/i, // mantenimiento de cuenta/paquete
      /^imp\.?\s*afip/i, // pago de impuestos a AFIP (no corresponde a una factura puntual)
      /debito\s*fiscal\s*iva/i, // desglose de IVA sobre comisiones/gastos bancarios
      /^debito\s*iva/i,
      /comision/i, // comisiones bancarias (transferencias, mantenimiento, etc.)
      /^com\.?\s/i, // "COM RETIRO EFECTIVO...": abreviatura de comisión
    ],
  },
  {
    category: "Retiros de efectivo",
    patterns: [
      /extrac/i, // EXTRACCION / EXTRAC EFVO: retiros de efectivo, no son pagos a terceros
      /retiro\s*efectivo/i,
      /cajero\s*autom/i, // extracción por cajero automático
    ],
  },
  {
    category: "Transferencias entre cuentas propias",
    patterns: [/\bmismo\b/i], // "MISMO TIT", "CCDO MISMO": movimientos entre cuentas del mismo titular
  },
  {
    category: "Movimientos de fondos / inversiones propias",
    patterns: [
      /liq\.?\s*susc/i, // "10 Liq.Susc ...": suscripción a un fondo común de inversión (plata que entra al fondo)
      /sol\.?\s*resc/i, // "10 Sol.Resc ...": rescate del fondo (la plata vuelve a la cuenta)
      /rescate\s*fondo/i,
      /fondo\s*de\s*inversi/i,
      /plazo\s*fijo/i, // constitución/vencimiento de un plazo fijo propio
    ], // todos son movimientos de la MISMA plata entre la cuenta y un instrumento propio (FCI, plazo fijo) — no hay contraparte real para cruzar
  },
  {
    // Distinto de "Impuestos y comisiones bancarias" a propósito: esto SÍ es
    // un pago a un tercero (un profesional), no un cargo interno del banco —
    // se categoriza aparte para no esconderlo como si fuera una comisión.
    // Si en algún momento llega la factura de ese profesional, hay que
    // sacarle la categoría a mano para que vuelva a conciliar contra ella.
    category: "Honorarios",
    patterns: [/pago\s*honorarios/i, /\bhonorarios\b/i],
  },
];

type MatchableTxn = { source: string; description: string };

export function isNonReconcilableBankMovement(t: MatchableTxn): boolean {
  if (t.source !== "bank") return false;
  return NON_RECONCILABLE_GROUPS.some((g) => g.patterns.some((re) => re.test(t.description)));
}

/** Devuelve la categoría a asignar si la descripción matchea un movimiento bancario interno conocido, o null si parece un movimiento real. */
export function detectBankFeeCategory(description: string): string | null {
  const trimmed = description.trim();
  const group = NON_RECONCILABLE_GROUPS.find((g) => g.patterns.some((re) => re.test(trimmed)));
  return group?.category ?? null;
}
