#!/usr/bin/env node
// Uso:
//   DATABASE_URL="<la de Neon>" node scripts/debug-afip-zero-amount.mjs
//
// Diagnóstico de comprobantes AFIP (emitidos o recibidos) que quedaron
// cargados con importe $0,00 — como el "Recibo C" de MARINOZZI JUAN PABLO
// que reportó Leo. El parser (src/lib/parsers/afip-csv.ts) toma el importe
// de la columna "Imp. Total" del CSV de AFIP tal cual viene; si para un tipo
// de comprobante (ej. Recibo) AFIP exporta el importe real en OTRA columna
// (p.ej. "Imp. Neto No Gravado"), el parser no tiene forma de saberlo sin ver
// el CSV real.
//
// Este script no adivina nada: lista cada comprobante con importe 0 y
// muestra el `raw` completo (la fila tal como vino del CSV, guardada en la
// columna jsonb `raw` de transactions) para poder ver a ojo en qué columna
// está la plata real, y de ahí ajustar el parser con el caso puntual.
//
// No modifica nada — solo lee y muestra.
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Falta DATABASE_URL. Uso: DATABASE_URL="..." node scripts/debug-afip-zero-amount.mjs');
  process.exit(1);
}

const sql = postgres(url);
const fmtDate = (d) => new Intl.DateTimeFormat("es-AR", { dateStyle: "short" }).format(new Date(d));

try {
  const rows = await sql`
    select id, source, date, description, counterparty, amount, raw
    from transactions
    where source in ('afip_issued', 'afip_received') and amount = 0
    order by date desc
  `;

  if (rows.length === 0) {
    console.log("No hay comprobantes AFIP con importe $0,00 cargados.");
    process.exit(0);
  }

  console.log(`${rows.length} comprobante(s) AFIP con importe $0,00:\n`);

  for (const r of rows) {
    console.log(`#${r.id}  ${r.source}  ${fmtDate(r.date)}  ${r.description}`);
    if (r.counterparty) console.log(`  Contraparte: ${r.counterparty}`);
    console.log("  Fila cruda del CSV (raw):");
    console.log(
      JSON.stringify(r.raw, null, 2)
        .split("\n")
        .map((l) => "    " + l)
        .join("\n"),
    );
    console.log("");
  }

  console.log(
    "Mandame esta salida (sobre todo el bloque 'raw' de alguno) y de ahí reviso en qué columna está el importe real para ese tipo de comprobante.",
  );
} finally {
  await sql.end();
}
