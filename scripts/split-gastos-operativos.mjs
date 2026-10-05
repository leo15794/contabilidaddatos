#!/usr/bin/env node
// Uso:
//   DATABASE_URL="<la de Neon>" node scripts/split-gastos-operativos.mjs
//     -> solo MUESTRA cómo quedaría el desglose (no toca la base)
//   DATABASE_URL="<la de Neon>" node scripts/split-gastos-operativos.mjs --apply
//     -> aplica la recategorización de verdad
//
// Migración de una sola vez: antes, TODOS los cargos de tarjeta conocidos
// (IVA, comisiones, sellos, intereses, punitorios...) se guardaban bajo un
// único "Gastos operativos" genérico. Ahora categorize-card-fees.mjs separa
// eso en categorías específicas ("Impuestos y comisiones bancarias",
// "Intereses y gastos financieros"), pero los movimientos que ya estaban
// categorizados de antes no se tocan solos — hay que re-pasarlos una vez con
// este script para que el desglose del Dashboard los muestre bien.
//
// Movimientos que quedan en "Gastos operativos" sin moverse: los que el
// parser marcó como cargo general del resumen (`raw.cargoDelResumen`) pero
// cuya descripción no matchea ninguno de los patrones específicos conocidos
// — no hay forma de saber de qué tipo son, así que se dejan como estaban.
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Falta DATABASE_URL. Uso: DATABASE_URL="..." node scripts/split-gastos-operativos.mjs [--apply]');
  process.exit(1);
}

const apply = process.argv.includes("--apply");

// Mismos grupos que src/lib/parsers/fee-categories.ts / categorize-card-fees.mjs.
const FEE_GROUPS = [
  {
    category: "Impuestos y comisiones bancarias",
    patterns: [/^PERCEP\.?\s*IVA/i, /^DB\s*IVA/i, /^COMIS\./i, /^IMPUESTO\s*DE\s*SELLOS/i, /^SELLADO\s*PROVINCIAL/i],
  },
  {
    category: "Intereses y gastos financieros",
    patterns: [/^INTERESES?\s*FINANCIACION/i, /^PUNIT\./i, /^TRANSFERENCIA\s*DEUDA/i],
  },
];

function detectSpecificCategory(description) {
  const trimmed = description.trim();
  const group = FEE_GROUPS.find((g) => g.patterns.some((re) => re.test(trimmed)));
  return group?.category ?? null;
}

const sql = postgres(url);
const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });

try {
  const rows = await sql`
    select id, date, description, amount
    from transactions
    where category = 'Gastos operativos'
    order by date desc
  `;

  if (rows.length === 0) {
    console.log('No hay movimientos con categoría "Gastos operativos" para revisar.');
    process.exit(0);
  }

  const toMove = rows
    .map((r) => ({ ...r, newCategory: detectSpecificCategory(r.description) }))
    .filter((r) => r.newCategory !== null);
  const staying = rows.length - toMove.length;

  if (toMove.length === 0) {
    console.log(
      `Revisé ${rows.length} movimiento(s) en "Gastos operativos" — ninguno matchea un patrón específico conocido, quedan como están.`,
    );
    process.exit(0);
  }

  console.log(
    `${apply ? "Recategorizando" : "Encontrados (dry-run, no se tocó nada)"}: ${toMove.length} de ${rows.length} movimiento(s) en "Gastos operativos" tienen una categoría más específica:\n`,
  );

  const byCategory = new Map();
  for (const r of toMove) {
    if (!byCategory.has(r.newCategory)) byCategory.set(r.newCategory, []);
    byCategory.get(r.newCategory).push(r);
  }
  for (const [category, rs] of byCategory) {
    const total = rs.reduce((acc, r) => acc + Math.abs(Number(r.amount)), 0);
    console.log(`"${category}" (${rs.length}, ${fmt.format(total)}):`);
    for (const r of rs.slice(0, 10)) {
      console.log(`  #${r.id}  ${r.description}  ${fmt.format(Math.abs(Number(r.amount)))}`);
    }
    if (rs.length > 10) console.log(`  ... y ${rs.length - 10} más`);
    console.log("");
  }
  console.log(`Quedan sin tocar en "Gastos operativos" (sin patrón específico): ${staying}`);

  if (apply) {
    for (const [category, rs] of byCategory) {
      const ids = rs.map((r) => r.id);
      await sql`update transactions set category = ${category} where id = any(${ids})`;
    }
    console.log(`\nListo — ${toMove.length} movimiento(s) recategorizados.`);
  } else {
    console.log('\nEsto fue solo una vista previa. Para aplicarlo de verdad, agregá "--apply" al comando.');
  }
} finally {
  await sql.end();
}
