import Papa from "papaparse";
import { ParseResult, ParsedRow, parseArDate, parseArNumber } from "./types";

/**
 * Parser para los CSV exportados desde "Mis Comprobantes" de AFIP
 * (tanto el listado de Comprobantes Emitidos como el de Recibidos).
 *
 * Las columnas estándar de AFIP son conocidas y estables, pero a veces
 * cambian mayúsculas/acentos entre exportaciones, así que buscamos por
 * nombre normalizado en vez de por posición fija.
 */

function normalizeHeader(h: string): string {
  return h
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // saca acentos
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function findColumn(
  headers: string[],
  candidates: string[],
): string | undefined {
  const normalized = headers.map((h) => ({ raw: h, norm: normalizeHeader(h) }));
  for (const candidate of candidates) {
    const nc = normalizeHeader(candidate);
    const exact = normalized.find((h) => h.norm === nc);
    if (exact) return exact.raw;
  }
  for (const candidate of candidates) {
    const nc = normalizeHeader(candidate);
    const partial = normalized.find((h) => h.norm.includes(nc));
    if (partial) return partial.raw;
  }
  return undefined;
}

export function parseAfipCsv(
  fileContent: string,
  direction: "issued" | "received",
): ParseResult {
  const parsed = Papa.parse<Record<string, string>>(fileContent, {
    header: true,
    skipEmptyLines: true,
    delimiter: "", // autodetecta ; o ,
  });

  const warnings: string[] = [...parsed.errors.map((e) => `Fila ${e.row}: ${e.message}`)];
  const headers = parsed.meta.fields ?? [];

  const col = {
    fecha: findColumn(headers, ["Fecha de Emision", "Fecha"]),
    // El export de "Mis Comprobantes" llama a esta columna simplemente
    // "Tipo" (ej. "3 - Nota de Crédito A") — "Tipo de Comprobante" no
    // aparece en ningún header real de AFIP que hayamos visto. Sin esta
    // columna, isCreditNote da siempre false y las notas de crédito quedan
    // con el signo invertido (AFIP las exporta con el importe en positivo
    // siempre, sin importar el tipo — el signo correcto depende 100% de
    // poder leer esta columna).
    tipo: findColumn(headers, ["Tipo", "Tipo de Comprobante", "Tipo Comprobante"]),
    puntoVenta: findColumn(headers, ["Punto de Venta"]),
    numeroDesde: findColumn(headers, ["Numero Desde", "Nro Desde", "Numero"]),
    docTipo:
      direction === "issued"
        ? findColumn(headers, ["Tipo Doc. Receptor", "Tipo Doc Receptor"])
        : findColumn(headers, ["Tipo Doc. Emisor", "Tipo Doc Emisor"]),
    docNro:
      direction === "issued"
        ? findColumn(headers, ["Nro. Doc. Receptor", "Nro Doc Receptor", "CUIT Receptor"])
        : findColumn(headers, ["Nro. Doc. Emisor", "Nro Doc Emisor", "CUIT Emisor"]),
    denominacion:
      direction === "issued"
        ? findColumn(headers, ["Denominacion Receptor"])
        : findColumn(headers, ["Denominacion Emisor"]),
    moneda: findColumn(headers, ["Moneda"]),
    total: findColumn(headers, ["Imp. Total", "Imp Total", "Importe Total"]),
    // El export "detallado" de AFIP (el que trae el desglose de IVA por
    // alícuota) NO tiene ninguna columna de total — hay que sumarla. Para un
    // comprobante "C" (monotributista, sin IVA) toda la plata cae en "Neto No
    // Gravado", así que si solo miramos "Imp. Total" (que en este formato ni
    // existe) el importe queda en $0. Si encontramos alguna de estas columnas,
    // el total se calcula sumándolas en vez de buscar una columna de total.
    netoGravadoTotal: findColumn(headers, ["Neto Gravado Total"]),
    netoNoGravado: findColumn(headers, ["Neto No Gravado"]),
    opExentas: findColumn(headers, ["Op. Exentas", "Imp. Op. Exentas"]),
    otrosTributos: findColumn(headers, ["Otros Tributos", "Imp. Trib."]),
    totalIva: findColumn(headers, ["Total IVA", "Imp. IVA"]),
  };

  const desglose = [col.netoGravadoTotal, col.netoNoGravado, col.opExentas, col.otrosTributos, col.totalIva];
  const tieneDesglose = desglose.some(Boolean);

  if (!col.fecha || (!col.total && !tieneDesglose)) {
    warnings.push(
      "No se pudieron identificar las columnas de fecha/importe total. Revisá que sea el CSV exportado desde AFIP > Mis Comprobantes.",
    );
    return { rows: [], warnings };
  }

  const rows: ParsedRow[] = [];

  for (const record of parsed.data) {
    const dateStr = col.fecha ? record[col.fecha] : undefined;
    const date = parseArDate(dateStr);
    if (!date) {
      warnings.push(`Fila sin fecha válida, se omite: ${JSON.stringify(record)}`);
      continue;
    }

    let amount: number;
    if (tieneDesglose) {
      amount = desglose.reduce((sum, colName) => sum + (colName ? parseArNumber(record[colName]) : 0), 0);
    } else {
      amount = col.total ? parseArNumber(record[col.total]) : 0;
    }
    const tipo = col.tipo ? record[col.tipo] ?? "" : "";
    const isCreditNote = /nota\s*de\s*cr[eé]dito/i.test(tipo);

    // Emitida = ingreso (a cobrar), salvo nota de crédito que lo invierte.
    // Recibida = egreso (a pagar), salvo nota de crédito que lo invierte.
    const baseSign = direction === "issued" ? 1 : -1;
    const sign = isCreditNote ? -baseSign : baseSign;
    amount = Math.abs(amount) * sign;

    const puntoVenta = col.puntoVenta ? record[col.puntoVenta] : "";
    const numero = col.numeroDesde ? record[col.numeroDesde] : "";
    const cuit = col.docNro ? record[col.docNro] : "";
    const razonSocial = col.denominacion ? record[col.denominacion] : "";

    const description = [tipo, puntoVenta && numero ? `${puntoVenta}-${numero}` : null, razonSocial]
      .filter(Boolean)
      .join(" · ");

    rows.push({
      date,
      description: description || `Comprobante AFIP ${direction === "issued" ? "emitido" : "recibido"}`,
      amount,
      currency: col.moneda ? record[col.moneda] || "ARS" : "ARS",
      counterparty: [cuit, razonSocial].filter(Boolean).join(" - ") || undefined,
      raw: record,
    });
  }

  return { rows, warnings };
}
