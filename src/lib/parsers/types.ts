/** Fila normalizada que producen todos los parsers, lista para insertar en `transactions`. */
export type ParsedRow = {
  date: Date;
  description: string;
  /** positivo = ingreso, negativo = egreso */
  amount: number;
  currency?: string;
  counterparty?: string;
  /** Si el parser ya sabe a qué cuenta/titular corresponde esta fila puntual (ej. un resumen con varias tarjetas adicionales), pisa el accountRef general del batch. */
  accountRef?: string;
  /** Si el parser ya detectó que esta fila es un cargo bancario sin contraparte real (ver `fee-categories.ts`), va directo categorizada y no necesita conciliación. */
  category?: string | null;
  raw: Record<string, unknown>;
};

export type ParseResult = {
  rows: ParsedRow[];
  warnings: string[];
};

/** Convierte un importe en formato argentino ("1.234,56" o "-1.234,56") a number. */
export function parseArNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  const trimmed = value.trim();
  if (trimmed === "") return 0;

  // Si tiene coma, asumimos formato AR: punto = miles, coma = decimales.
  if (trimmed.includes(",")) {
    const normalized = trimmed.replace(/\./g, "").replace(",", ".");
    const n = Number(normalized);
    return Number.isFinite(n) ? n : 0;
  }

  // Sin coma: puede ser un número "en inglés" (1234.56) o un entero.
  const n = Number(trimmed.replace(/(?<=\d)\.(?=\d{3}(\D|$))/g, ""));
  return Number.isFinite(n) ? n : Number(trimmed) || 0;
}

/** Intenta parsear fechas en los formatos más comunes de AR: dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd. */
export function parseArDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;

  // yyyy-mm-dd o yyyy/mm/dd
  let m = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) {
    const [, y, mo, d] = m;
    return new Date(Number(y), Number(mo) - 1, Number(d));
  }

  // dd-mm-yyyy o dd/mm/yyyy
  m = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (m) {
    const [, d, mo, y] = m;
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    return new Date(year, Number(mo) - 1, Number(d));
  }

  const asDate = new Date(trimmed);
  return Number.isNaN(asDate.getTime()) ? null : asDate;
}
