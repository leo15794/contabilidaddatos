/**
 * Detecta cargos bancarios que nunca van a tener una contraparte real para
 * cruzar (comisiones, impuestos, intereses que el banco cobra DIRECTO en el
 * resumen de tarjeta) — para categorizarlos como "Gastos operativos" ya en
 * el momento de importar, en vez de que aparezcan como "sin conciliar" y
 * haya que marcarlos a mano o correr `scripts/categorize-card-fees.mjs`
 * después.
 *
 * OJO: estos mismos patrones están duplicados en
 * `scripts/categorize-card-fees.mjs` (ese script es un .mjs plano para
 * poder correrlo con `node` directo, sin pasar por el build de Next, así
 * que no puede importar este archivo .ts) — si se agrega un patrón nuevo
 * acá, hay que agregarlo ahí también para que el catch-up manual y la
 * categorización automática de las próximas importaciones coincidan.
 */

export const DEFAULT_FEE_CATEGORY = "Gastos operativos";

// Conservador a propósito: matchea el PREFIJO exacto de cada línea
// boilerplate de Banco Macro, no palabras sueltas — para no agarrar por
// error un consumo real que tenga una de estas palabras en el medio.
const FEE_PATTERNS = [
  /^PERCEP\.?\s*IVA/i,
  /^DB\s*IVA/i,
  /^COMIS\./i, // COMIS.RENOVAC..., COMIS.MANTENIMIENTO, "COMIS. MANTENIMIENTO", etc.
  /^IMPUESTO\s*DE\s*SELLOS/i,
  /^SELLADO\s*PROVINCIAL/i,
  /^INTERESES?\s*FINANCIACION/i,
  /^PUNIT\./i, // PUNIT.PAG.MIN.ANTERIOR
  /^TRANSFERENCIA\s*DEUDA/i,
];

/** Devuelve la categoría a asignar si la descripción matchea un cargo bancario conocido, o null si parece un consumo real. */
export function detectFeeCategory(description: string): string | null {
  const trimmed = description.trim();
  return FEE_PATTERNS.some((re) => re.test(trimmed)) ? DEFAULT_FEE_CATEGORY : null;
}
