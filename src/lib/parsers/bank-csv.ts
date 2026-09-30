import Papa from "papaparse";
import { ParseResult, ParsedRow, parseArDate, parseArNumber } from "./types";

/**
 * Parser genérico de movimientos bancarios en CSV/Excel-exportado-a-CSV.
 *
 * Cada banco exporta con columnas distintas, así que en vez de adivinar,
 * el mapeo de columnas (qué columna es la fecha, cuál la descripción, etc.)
 * se define una vez por banco desde la UI y se reusa en las próximas subidas
 * de ese mismo banco (se guarda en `import_batches.column_mapping`).
 */

export type BankColumnMapping = {
  dateColumn: string;
  descriptionColumn: string;
  /** Si el banco separa débito/crédito en dos columnas, se usan estas dos en vez de amountColumn. */
  amountColumn?: string;
  debitColumn?: string;
  creditColumn?: string;
};

export function sniffHeaders(fileContent: string): string[] {
  const parsed = Papa.parse<Record<string, string>>(fileContent, {
    header: true,
    skipEmptyLines: true,
    preview: 1,
  });
  return parsed.meta.fields ?? [];
}

export function parseBankCsv(
  fileContent: string,
  mapping: BankColumnMapping,
): ParseResult {
  const parsed = Papa.parse<Record<string, string>>(fileContent, {
    header: true,
    skipEmptyLines: true,
  });

  const warnings: string[] = [...parsed.errors.map((e) => `Fila ${e.row}: ${e.message}`)];
  const rows: ParsedRow[] = [];

  for (const record of parsed.data) {
    const date = parseArDate(record[mapping.dateColumn]);
    if (!date) {
      warnings.push(`Fila sin fecha válida, se omite: ${JSON.stringify(record)}`);
      continue;
    }

    let amount: number;
    if (mapping.amountColumn) {
      amount = parseArNumber(record[mapping.amountColumn]);
    } else if (mapping.debitColumn && mapping.creditColumn) {
      const debit = parseArNumber(record[mapping.debitColumn]);
      const credit = parseArNumber(record[mapping.creditColumn]);
      amount = credit - Math.abs(debit);
    } else {
      warnings.push("Mapeo de columnas incompleto: falta importe (o débito/crédito).");
      continue;
    }

    rows.push({
      date,
      description: record[mapping.descriptionColumn] || "(sin descripción)",
      amount,
      currency: "ARS",
      raw: record,
    });
  }

  return { rows, warnings };
}
