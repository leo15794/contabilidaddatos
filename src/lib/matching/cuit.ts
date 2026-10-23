const CUIT_PREFIXES = new Set(["20", "23", "24", "27", "30", "33", "34"]);
const CUIT_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

/** Valida prefijo y dígito verificador (módulo 11) de un CUIT/CUIL de 11 dígitos. */
export function isValidCuit(digits: string): boolean {
  if (!/^\d{11}$/.test(digits)) return false;
  if (!CUIT_PREFIXES.has(digits.slice(0, 2))) return false;
  const sum = CUIT_WEIGHTS.reduce((acc, w, i) => acc + w * Number(digits[i]), 0);
  let check = 11 - (sum % 11);
  if (check === 11) check = 0;
  if (check === 10) check = 9; // caso especial que usa AFIP
  return check === Number(digits[10]);
}

/**
 * Extrae CUITs (11 dígitos) de un texto libre. Sirve para la descripción de
 * transferencias bancarias, que muchas veces traen el CUIT del destinatario
 * pegado al final ("TEF DATANET PR BOLDT SA SG DIGITA 30717665011",
 * "TRANSF:2606190000643422659280-30717898733"), con o sin guiones
 * ("30-71766501-1"). Devuelve los 11 dígitos sin guiones.
 *
 * Solo se aceptan corridas de EXACTAMENTE 11 dígitos (no un pedazo de un
 * número más largo, como un CBU o un número de operación) y con dígito
 * verificador válido — así un número de referencia cualquiera de 11 dígitos
 * no se confunde con un CUIT.
 *
 * OJO: esto NO existe para consumos de tarjeta — el resumen de tarjeta
 * (PDF) solo trae fecha + nombre de comercio + importe, nunca CUIT. No
 * tiene sentido llamar a esto para texto de `card`.
 */
export function extractCuits(text: string | null | undefined): string[] {
  if (!text) return [];
  const cuits = new Set<string>();

  for (const m of text.matchAll(/(?<!\d)(\d{2})-(\d{8})-(\d)(?!\d)/g)) {
    const digits = m[1] + m[2] + m[3];
    if (isValidCuit(digits)) cuits.add(digits);
  }
  for (const m of text.matchAll(/(?<!\d)\d{11}(?!\d)/g)) {
    if (isValidCuit(m[0])) cuits.add(m[0]);
  }

  return [...cuits];
}
