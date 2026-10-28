import * as XLSX from "xlsx";
import type { ParsedRow, ParseResult } from "./types";

/**
 * Hoja "Gastos Socios" de la planilla de contabilidad: los gastos que paga cada
 * socio, un bloque por mes ("Gastos Abril", "Gastos Mayo"...) con las columnas
 * Fecha | Razón Social | Monto | IVA | Otros Imp | Total | Origen | Quién.
 *
 * Solo entran las filas pagadas en efectivo ("Efectivo - Propio", "Efectivo -
 * Reintegrado", "Efectivo de la Caja..."): las de tarjeta y transferencia ya
 * tienen su movimiento en el resumen o en el banco, y cargarlas dos veces
 * duplicaría el pago.
 *
 * Las fechas son celdas de fecha de Excel (traen el año aunque se vean "28/04").
 * Si alguna viene escrita como texto sin año, se usa el de la fila anterior o el
 * que se indica al subir, y si vuelve a un mes muy anterior (diciembre -> enero)
 * se pasa al año siguiente.
 */
const SHEET_NAME = /gastos\s+socios/i;
const CASH_ORIGIN = /efectivo/i;

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  const s = String(value ?? "").replace(/[$\s]/g, "");
  if (s === "") return NaN;
  // La planilla usa formato inglés ("1,234.56"); por las dudas se acepta "1.234,56".
  const normalized = /,\d{1,2}$/.test(s) ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  return Number(normalized);
}

const cleanQuien = (q: string) => q.replace(/\s*propio\s*$/i, "").trim() || "Sin indicar";

export function parseGastosSociosXlsx(data: ArrayBuffer, startYear: number): ParseResult {
  const warnings: string[] = [];
  const wb = XLSX.read(data, { type: "array" });
  const sheetName = wb.SheetNames.find((n) => SHEET_NAME.test(n));
  if (!sheetName) {
    return { rows: [], warnings: ['El archivo no tiene una hoja "Gastos Socios".'] };
  }

  const table = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1, raw: true, defval: "" });
  const rows: ParsedRow[] = [];
  const seen = new Set<string>();
  let year = startYear;
  let lastMonth = 0;
  let notCash = 0;

  table.forEach((r, i) => {
    const total = toNumber(r[5]);
    if (!(total > 0)) return;

    let day: number;
    let month: number;
    if (typeof r[0] === "number") {
      // Celda de fecha de Excel: trae el año real aunque se vea "28/04".
      const d = XLSX.SSF.parse_date_code(r[0]);
      if (!d || d.y < 2000) return;
      [year, month, day] = [d.y, d.m, d.d];
    } else {
      const m = String(r[0] ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
      if (!m) return;
      day = Number(m[1]);
      month = Number(m[2]);
      if (m[3]) {
        year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      } else if (lastMonth && month < lastMonth - 6) {
        year++;
      }
    }
    lastMonth = month;

    const origen = String(r[6] ?? "").trim();
    if (!CASH_ORIGIN.test(origen)) {
      notCash++;
      return;
    }

    const razon = String(r[1] ?? "").trim() || "Sin razón social";
    const quien = cleanQuien(String(r[7] ?? ""));
    const date = new Date(Date.UTC(year, month - 1, day));
    const key = `${date.toISOString()}|${razon.toLowerCase()}|${total.toFixed(2)}`;
    if (seen.has(key)) {
      warnings.push(`Fila ${i + 1}: ${razon} por ${total.toFixed(2)} está repetida en la hoja; se cargó una sola vez.`);
      return;
    }
    seen.add(key);

    rows.push({
      date,
      description: `Efectivo · ${razon}`,
      amount: -Math.round(total * 100) / 100,
      counterparty: razon,
      accountRef: `Efectivo · ${quien}`,
      raw: {
        hoja: sheetName,
        fila: i + 1,
        origen,
        quien,
        neto: toNumber(r[2]) || null,
        iva: toNumber(r[3]) || null,
        otrosImpuestos: toNumber(r[4]) || null,
      },
    });
  });

  if (notCash > 0) {
    warnings.push(`${notCash} filas pagadas con tarjeta o transferencia no se cargaron: ya tienen su movimiento en el resumen o en el banco.`);
  }
  return { rows, warnings };
}
