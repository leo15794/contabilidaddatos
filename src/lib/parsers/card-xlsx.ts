import * as XLSX from "xlsx";
import { ParseResult } from "./types";
import { StatementExtraction, CardholderExtraction, buildRowsFromExtraction } from "./card-statement-shared";

/**
 * Carga a mano de un resumen de tarjeta vía planilla Excel, para los casos
 * en que ni el lector por texto ni el lector visual con Claude pueden leer
 * el PDF (típicamente porque Claude tarda más de los 60s que deja Vercel en
 * el plan Hobby — ver el comentario en `card-pdf-vision.ts`). En vez de
 * reintentar a ciegas una API que ya sabemos que no va a responder a
 * tiempo, se tipea (o se pega) la misma información en una planilla con un
 * formato fijo, y entra por este camino — sin ninguna llamada a una API
 * externa, así que no hay límite de tiempo que la pueda cortar.
 *
 * Formato esperado (primera hoja, primera fila = encabezados, sin
 * mayúsculas/acentos obligatorios — se normalizan):
 *
 *   tarjeta | titular | subtotal_impreso | tipo | fecha | comprobante | descripcion | cuotas | importe
 *
 * - `tipo` es "consumo" (default si se deja vacío) o "cargo".
 * - Las filas "consumo" se agrupan por (tarjeta, titular) y se valida que la
 *   suma de sus importes cierre contra `subtotal_impreso` — mismo checksum
 *   que usa el lector visual, para no perder esa protección solo por cargar
 *   a mano.
 * - Las filas "cargo" (impuestos, comisiones, IVA del resumen en general)
 *   no necesitan tarjeta/titular/subtotal — van directo a `cargosVarios`.
 * - `fecha` en formato DD/MM/AAAA.
 * - `importe` siempre positivo (se guarda como egreso automáticamente).
 */

function normalizeHeader(h: string): string {
  return h
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, ""); // saca acentos: "descripción" -> "descripcion"
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (value === null || value === undefined) return 0;
  const s = String(value).trim();
  if (s === "") return 0;
  if (s.includes(",")) {
    const n = Number(s.replace(/\./g, "").replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function toText(value: unknown): string {
  if (value === null || value === undefined) return "";
  // Excel puede traer una fecha como objeto Date si la celda está formateada
  // como fecha — se normaliza a DD/MM/AAAA para que parseArDate la entienda.
  if (value instanceof Date) {
    const d = String(value.getDate()).padStart(2, "0");
    const m = String(value.getMonth() + 1).padStart(2, "0");
    return `${d}/${m}/${value.getFullYear()}`;
  }
  return String(value).trim();
}

export function parseCardStatementXlsx(
  fileBuffer: Buffer,
): ParseResult & { extraction: StatementExtraction | null; needsReview: boolean; reviewNotes: string[] } {
  let rows: Record<string, unknown>[];
  try {
    const workbook = XLSX.read(fileBuffer, { type: "buffer", cellDates: true });
    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      return { rows: [], warnings: ["La planilla no tiene ninguna hoja."], extraction: null, needsReview: true, reviewNotes: [] };
    }
    const sheet = workbook.Sheets[firstSheetName];
    const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    rows = raw.map((r) => {
      const normalized: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) normalized[normalizeHeader(k)] = v;
      return normalized;
    });
  } catch (err) {
    return {
      rows: [],
      warnings: [`No se pudo leer el archivo Excel: ${err instanceof Error ? err.message : String(err)}`],
      extraction: null,
      needsReview: true,
      reviewNotes: [],
    };
  }

  if (rows.length === 0) {
    return { rows: [], warnings: ["La planilla no tiene filas."], extraction: null, needsReview: true, reviewNotes: [] };
  }

  const warnings: string[] = [];
  const cardholderMap = new Map<string, CardholderExtraction>();
  const cargosVarios: { descripcion: string; importe: number }[] = [];
  let lastFecha = "";

  rows.forEach((r, i) => {
    const tipo = normalizeHeader(toText(r["tipo"]) || "consumo");
    const fecha = toText(r["fecha"]);
    const descripcion = toText(r["descripcion"]) || toText(r["descripción"]);
    const importe = toNumber(r["importe"]);

    if (tipo === "cargo") {
      if (!descripcion || !importe) {
        warnings.push(`Fila ${i + 2}: fila "cargo" sin descripción o importe, se omite.`);
        return;
      }
      cargosVarios.push({ descripcion, importe: Math.abs(importe) });
      return;
    }

    const cardNumber = toText(r["tarjeta"]);
    const name = toText(r["titular"]);
    if (!cardNumber || !name) {
      warnings.push(`Fila ${i + 2}: falta "tarjeta" o "titular", se omite.`);
      return;
    }
    if (!fecha || !descripcion || !importe) {
      warnings.push(`Fila ${i + 2}: falta fecha, descripción o importe, se omite.`);
      return;
    }
    if (fecha) lastFecha = fecha;

    const key = `${cardNumber}|${name}`;
    let ch = cardholderMap.get(key);
    if (!ch) {
      ch = {
        cardNumber,
        name,
        subtotalImpreso: toNumber(r["subtotal_impreso"]),
        consumos: [],
      };
      cardholderMap.set(key, ch);
    }
    ch.consumos.push({
      fecha,
      comprobante: toText(r["comprobante"]),
      descripcion,
      cuotas: toText(r["cuotas"]) || null,
      importe: Math.abs(importe),
    });
  });

  if (cardholderMap.size === 0 && cargosVarios.length === 0) {
    return {
      rows: [],
      warnings: [...warnings, "No se pudo leer ningún consumo de la planilla — revisá que las columnas tengan los nombres esperados (tarjeta, titular, subtotal_impreso, fecha, descripcion, importe)."],
      extraction: null,
      needsReview: true,
      reviewNotes: [],
    };
  }

  const extraction: StatementExtraction = {
    emisor: null,
    cierre: lastFecha || null,
    vencimiento: null,
    saldoAnterior: null,
    saldoActual: null,
    pagoMinimo: null,
    cargosVarios,
    cardholders: Array.from(cardholderMap.values()),
  };

  const built = buildRowsFromExtraction(extraction);
  return {
    rows: built.rows,
    warnings: [...warnings, ...built.warnings],
    extraction,
    needsReview: built.needsReview,
    reviewNotes: built.reviewNotes,
  };
}
