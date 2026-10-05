/**
 * Extrae CUITs (11 dígitos) de un texto libre. Sirve para la descripción de
 * transferencias bancarias, que muchas veces traen el CUIT del destinatario
 * pegado al final ("TEF DATANET PR BOLDT SA SG DIGITA 30717665011"), con o
 * sin guiones ("30-71766501-1"). Devuelve los 11 dígitos sin guiones.
 *
 * OJO: esto NO existe para consumos de tarjeta — el resumen de tarjeta
 * (PDF) solo trae fecha + nombre de comercio + importe, nunca CUIT. No
 * tiene sentido llamar a esto para texto de `card`.
 */
export function extractCuits(text: string | null | undefined): string[] {
  if (!text) return [];
  // Corre de dígitos y guiones de 11 a 15 caracteres (para no agarrar un
  // pedazo de un número más largo, como un CBU) — se filtra después a los
  // que, sin los guiones, quedan en exactamente 11 dígitos.
  const runs = text.match(/[\d-]{11,15}/g) ?? [];
  const cuits = new Set<string>();
  for (const run of runs) {
    const digits = run.replace(/-/g, "");
    if (digits.length === 11) cuits.add(digits);
  }
  return [...cuits];
}
