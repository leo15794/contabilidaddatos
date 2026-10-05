/**
 * Detecta cargos bancarios que nunca van a tener una contraparte real para
 * cruzar (comisiones, impuestos, intereses que el banco cobra DIRECTO en el
 * resumen de tarjeta) — para categorizarlos ya en el momento de importar, en
 * vez de que aparezcan como "sin conciliar" y haya que marcarlos a mano o
 * correr `scripts/categorize-card-fees.mjs` después.
 *
 * Agrupados por categoría (antes todo cayía en un único "Gastos operativos"
 * genérico, que mezclaba impuestos/comisiones con intereses de financiación
 * — cosas de naturaleza distinta) para que el desglose en el Dashboard sea
 * útil y no un solo bloque sin abrir.
 *
 * OJO: estos mismos grupos están duplicados en
 * `scripts/categorize-card-fees.mjs` (ese script es un .mjs plano para
 * poder correrlo con `node` directo, sin pasar por el build de Next, así
 * que no puede importar este archivo .ts) — si se agrega un patrón nuevo
 * acá, hay que agregarlo ahí también para que el catch-up manual y la
 * categorización automática de las próximas importaciones coincidan.
 */

// Fallback cuando el parser marca la línea como cargo del resumen
// (`raw.cargoDelResumen`) pero no matchea ninguno de los patrones de abajo —
// sabemos que es un cargo del banco, pero no de qué tipo específico.
export const DEFAULT_FEE_CATEGORY = "Gastos operativos";

// Conservador a propósito: matchea el PREFIJO exacto de cada línea
// boilerplate de Banco Macro, no palabras sueltas — para no agarrar por
// error un consumo real que tenga una de estas palabras en el medio.
const FEE_GROUPS: { category: string; patterns: RegExp[] }[] = [
  {
    // Mismo nombre que la categoría equivalente del lado banco
    // (`src/lib/matching/exclusions.ts`) a propósito — son el mismo tipo de
    // concepto, solo que cobrado directo en el resumen de tarjeta.
    category: "Impuestos y comisiones bancarias",
    patterns: [
      /^PERCEP\.?\s*IVA/i,
      /^DB\s*IVA/i,
      /^COMIS\./i, // COMIS.RENOVAC..., COMIS.MANTENIMIENTO, "COMIS. MANTENIMIENTO", etc.
      /^IMPUESTO\s*DE\s*SELLOS/i,
      /^SELLADO\s*PROVINCIAL/i,
    ],
  },
  {
    // Costo de financiar el saldo de tarjeta (cuotas, pago mínimo) — es
    // plata que sale por financiación, no un impuesto ni una comisión fija,
    // así que se categoriza aparte.
    category: "Intereses y gastos financieros",
    patterns: [
      /^INTERESES?\s*FINANCIACION/i,
      /^PUNIT\./i, // PUNIT.PAG.MIN.ANTERIOR
      /^TRANSFERENCIA\s*DEUDA/i,
    ],
  },
];

/** Devuelve la categoría a asignar si la descripción matchea un cargo bancario conocido, o null si parece un consumo real. */
export function detectFeeCategory(description: string): string | null {
  const trimmed = description.trim();
  const group = FEE_GROUPS.find((g) => g.patterns.some((re) => re.test(trimmed)));
  return group?.category ?? null;
}
