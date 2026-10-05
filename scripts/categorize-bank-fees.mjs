#!/usr/bin/env node
// Uso:
//   DATABASE_URL="<la de Neon>" node scripts/categorize-bank-fees.mjs           (solo mira, no cambia nada)
//   DATABASE_URL="<la de Neon>" node scripts/categorize-bank-fees.mjs --apply   (categoriza)
//
// Catch-up para movimientos de banco YA importados antes de que el parser
// empezara a categorizarlos solo (ver detectBankFeeCategory en
// src/lib/matching/exclusions.ts): impuestos/comisiones propias del banco
// (TASA GRAL, SIRCREB, comisiones, mantenimiento), retiros de efectivo, y
// transferencias entre cuentas del mismo titular. Ninguno de estos iba a
// conciliar nunca contra una factura o pago real — categorizarlos los saca
// de "sin conciliar" y limpia el Dashboard/Importaciones/Revisión sin tener
// que marcarlos a mano uno por uno.
//
// OJO: estos mismos grupos están duplicados de
// src/lib/matching/exclusions.ts (ese archivo es TypeScript, este script es
// un .mjs plano para poder correrlo con `node` directo) — si se agrega un
// patrón nuevo en uno, hay que agregarlo en el otro también.
import postgres from "postgres";

const APPLY = process.argv.includes("--apply");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Falta DATABASE_URL. Uso: DATABASE_URL="..." node scripts/categorize-bank-fees.mjs [--apply]');
  process.exit(1);
}

const GROUPS = [
  {
    category: "Impuestos y comisiones bancarias",
    patterns: [
      /tasa\s*gral/i,
      /sircreb/i,
      /retenci/i,
      /mantenimiento/i,
      /^imp\.?\s*afip/i,
      /debito\s*fiscal\s*iva/i,
      /^debito\s*iva/i,
      /comision/i,
      /^com\.?\s/i,
    ],
  },
  {
    category: "Retiros de efectivo",
    patterns: [/extrac/i, /retiro\s*efectivo/i, /cajero\s*autom/i],
  },
  {
    category: "Transferencias entre cuentas propias",
    patterns: [/\bmismo\b/i],
  },
];

function detectCategory(description) {
  const trimmed = (description ?? "").trim();
  const group = GROUPS.find((g) => g.patterns.some((re) => re.test(trimmed)));
  return group?.category ?? null;
}

const sql = postgres(url);
const fmtDate = (d) => new Intl.DateTimeFormat("es-AR", { dateStyle: "short" }).format(new Date(d));
const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });

try {
  const rows = await sql`
    select id, date, description, amount
    from transactions
    where source = 'bank' and category is null
    order by date
  `;

  const byCategory = new Map();
  for (const row of rows) {
    const category = detectCategory(row.description);
    if (!category) continue;
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(row);
  }

  const total = [...byCategory.values()].reduce((sum, rs) => sum + rs.length, 0);

  if (total === 0) {
    console.log("No hay movimientos de banco sin categorizar que matcheen estos patrones.");
    process.exit(0);
  }

  console.log(`${total} movimiento(s) de banco para categorizar:\n`);
  for (const [category, rs] of byCategory) {
    console.log(`"${category}" (${rs.length}):`);
    for (const r of rs.slice(0, 10)) {
      console.log(`  #${r.id}  ${fmtDate(r.date)}  ${r.description}  ${fmt.format(Number(r.amount))}`);
    }
    if (rs.length > 10) console.log(`  ... y ${rs.length - 10} más`);
    console.log("");
  }

  if (!APPLY) {
    console.log(`Esto fue solo una vista previa — no se cambió nada. Para categorizarlos, corré:`);
    console.log(`  DATABASE_URL="..." node scripts/categorize-bank-fees.mjs --apply`);
  } else {
    for (const [category, rs] of byCategory) {
      const ids = rs.map((r) => r.id);
      await sql`update transactions set category = ${category} where id = any(${ids})`;
    }
    console.log(`Categorizados ${total} movimiento(s). Ya no van a aparecer como "sin conciliar".`);
  }
} finally {
  await sql.end();
}
