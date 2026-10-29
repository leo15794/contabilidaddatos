import Papa from "papaparse";
import { parseArDate } from "./types";

/** Una fila del reporte "Compras" de MercadoLibre (un producto de una compra). */
export type MlPurchaseRow = {
  purchaseId: string;
  orderId: string;
  itemId: string;
  date: Date;
  product: string;
  quantity: number;
  unitPrice: number;
  /** "Precio total": total del vendedor dentro de la compra, repetido en cada producto suyo. */
  packTotal: number;
  shipping: number;
  taxes: number;
  paymentMethod: string | null;
  buyer: string | null;
};

// El reporte trae los importes sin separador de miles y con punto decimal
// ("425337.61"): `parseArNumber` leería "1.234" como mil doscientos.
const num = (v: string | undefined) => {
  const n = Number((v ?? "").trim());
  return Number.isFinite(n) ? n : 0;
};

const pick = (row: Record<string, string>, ...names: string[]) => {
  for (const name of names) {
    const key = Object.keys(row).find((k) => k.trim().toLowerCase() === name.toLowerCase());
    if (key !== undefined) return row[key]?.trim() ?? "";
  }
  return "";
};

/** Lee el CSV (separado por punto y coma) que exporta MercadoLibre en Compras > Descargar reporte. */
export function parseMercadoLibreCsv(content: string): { rows: MlPurchaseRow[]; warnings: string[] } {
  const parsed = Papa.parse<Record<string, string>>(content.replace(/^﻿/, ""), {
    header: true,
    delimiter: ";",
    skipEmptyLines: true,
  });

  const rows: MlPurchaseRow[] = [];
  const warnings: string[] = [];
  const headers = parsed.meta.fields ?? [];
  if (!headers.some((h) => /n° de compra/i.test(h)) || !headers.some((h) => /precio total/i.test(h))) {
    return { rows, warnings: ["El archivo no parece un reporte de compras de MercadoLibre (faltan las columnas \"N° de compra\" y \"Precio total\")."] };
  }

  parsed.data.forEach((r, i) => {
    const purchaseId = pick(r, "N° de compra");
    const orderId = pick(r, "N° de orden");
    const date = parseArDate(pick(r, "Fecha de compra"));
    const packTotal = num(pick(r, "Precio total"));
    if (!purchaseId || !orderId || !date || packTotal <= 0) {
      warnings.push(`Fila ${i + 2}: sin número de compra, fecha o precio total, se saltea.`);
      return;
    }
    rows.push({
      purchaseId,
      orderId,
      itemId: pick(r, "Item ID"),
      date,
      product: pick(r, "Producto") || "(sin descripción)",
      quantity: Math.max(1, Math.round(num(pick(r, "Cantidad")))),
      unitPrice: num(pick(r, "Precio unitario")),
      packTotal,
      shipping: num(pick(r, "Costo de envío")),
      taxes: num(pick(r, "Impuestos")),
      paymentMethod: pick(r, "Medio de pago") || null,
      buyer: pick(r, "Receptor") || null,
    });
  });

  return { rows, warnings };
}
