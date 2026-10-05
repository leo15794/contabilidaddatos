#!/usr/bin/env node
// Uso:
//   DATABASE_URL="<la de Neon>" node scripts/fill-afip-c-totals.mjs           (solo mira, no cambia nada)
//   DATABASE_URL="<la de Neon>" node scripts/fill-afip-c-totals.mjs --apply   (completa los importes)
//
// AFIP no manda el importe ("Imp. Total") para comprobantes recibidos tipo C
// (Factura/Recibo/Nota de Crédito C, de monotributistas) en el CSV de "Mis
// Comprobantes" — ese dato directamente no está en el archivo, así que
// quedaron todos cargados en $0,00. Pero esa plata YA la tenías cargada a
// mano en tu Google Sheet "FACTURAS RECIBIDAS" (columna de Total real), así
// que en vez de pedirte que la tipees de nuevo una por una en la app, este
// script usa esos mismos valores — ya extraídos a `scripts/data/afip-recibidas-totales.json`
// (754 comprobantes, generado desde esa planilla) — y completa los que estén
// en $0,00 en tu base, cruzando por CUIT + Punto de Venta + Número.
//
// Si en el futuro agregás más filas a la planilla, pedime que regenere este
// JSON con los datos nuevos antes de volver a correr esto.
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes("--apply");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Falta DATABASE_URL. Uso: DATABASE_URL="..." node scripts/fill-afip-c-totals.mjs [--apply]');
  process.exit(1);
}

const lookupPath = join(__dirname, "data", "afip-recibidas-totales.json");
const lookup = JSON.parse(readFileSync(lookupPath, "utf-8"));

function keyFromRaw(raw) {
  const cuit = raw?.["Nro. Doc. Emisor"];
  const puntoVenta = raw?.["Punto de Venta"];
  const numero = raw?.["Numero Desde"];
  if (cuit == null || puntoVenta == null || numero == null) return null;
  const c = Math.trunc(parseFloat(cuit));
  const pv = Math.trunc(parseFloat(puntoVenta));
  const n = Math.trunc(parseFloat(numero));
  if (!Number.isFinite(c) || !Number.isFinite(pv) || !Number.isFinite(n)) return null;
  return `${c}|${pv}|${n}`;
}

// Mismo criterio que usa la app al importar (ver src/lib/parsers/afip-csv.ts)
// y al editar un importe a mano (ver updateTransactionAmount en src/lib/queries.ts):
// recibida = egreso (negativo), salvo nota de crédito que lo invierte.
function signedAmount(description, absoluteAmount) {
  const isCreditNote = /nota\s*de\s*cr[eé]dito/i.test(description ?? "");
  const sign = isCreditNote ? 1 : -1;
  return Math.abs(absoluteAmount) * sign;
}

const sql = postgres(url);
const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });
const fmtDate = (d) => new Intl.DateTimeFormat("es-AR", { dateStyle: "short" }).format(new Date(d));

try {
  const rows = await sql`
    select id, date, description, raw
    from transactions
    where source = 'afip_received' and amount = 0
    order by date
  `;

  if (rows.length === 0) {
    console.log("No hay comprobantes AFIP recibidos en $0,00. Nada para completar.");
    process.exit(0);
  }

  console.log(`${rows.length} comprobante(s) en $0,00. Cruzando contra ${Object.keys(lookup).length} totales conocidos de tu planilla...\n`);

  const toUpdate = [];
  const sinDato = [];

  for (const row of rows) {
    const k = keyFromRaw(row.raw);
    const found = k ? lookup[k] : null;

    if (found) {
      const amount = signedAmount(row.description, found.total);
      toUpdate.push({ id: row.id, date: row.date, description: row.description, amount, total: found.total });
    } else {
      sinDato.push({ id: row.id, date: row.date, description: row.description });
    }
  }

  console.log(`✓ ${toUpdate.length} con dato en la planilla (se van a completar):`);
  for (const u of toUpdate.slice(0, 20)) {
    console.log(`  #${u.id}  ${fmtDate(u.date)}  ${u.description}  ->  ${fmt.format(u.amount)}`);
  }
  if (toUpdate.length > 20) console.log(`  ... y ${toUpdate.length - 20} más`);

  if (sinDato.length > 0) {
    console.log(`\n✗ ${sinDato.length} sin dato en la planilla (quedan en $0,00, hay que cargarlos a mano desde /importaciones):`);
    for (const u of sinDato) {
      console.log(`  #${u.id}  ${fmtDate(u.date)}  ${u.description}`);
    }
  }

  if (!APPLY) {
    console.log(`\nEsto fue solo una vista previa — no se cambió nada. Para completar los ${toUpdate.length} importes, corré:`);
    console.log(`  DATABASE_URL="..." node scripts/fill-afip-c-totals.mjs --apply`);
  } else if (toUpdate.length === 0) {
    console.log("\nNada para completar.");
  } else {
    for (const u of toUpdate) {
      await sql`update transactions set amount = ${u.amount.toFixed(2)} where id = ${u.id}`;
    }
    console.log(`\nCompletados ${toUpdate.length} importe(s). Entrá al Dashboard y apretá "Re-conciliar" para que el motor intente matchearlos ahora que ya no están en $0.`);
  }
} finally {
  await sql.end();
}
