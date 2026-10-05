#!/usr/bin/env node
// Uso:
//   DATABASE_URL="<la de Neon>" node scripts/categorize-card-fees.mjs
//     -> solo MUESTRA qué movimientos marcaría (no toca la base)
//   DATABASE_URL="<la de Neon>" node scripts/categorize-card-fees.mjs --apply
//     -> aplica las categorías de verdad
//
// Categoriza de una sola pasada los cargos típicos que el banco cobra DIRECTO
// en el resumen de tarjeta (IVA, comisiones, sellos, intereses, etc.) — nunca
// van a tener una factura o transferencia con la que cruzar, así que no
// tiene sentido que sigan apareciendo como "sin conciliar". Es exactamente
// el mismo campo `category` que usa el botón manual de /importaciones, así
// que lo que haga este script se ve y se puede deshacer desde ahí también.
//
// Agrupado por tipo (impuestos/comisiones vs. intereses de financiación) en
// vez de un único "Gastos operativos" genérico — así el desglose del
// Dashboard sirve para algo. Lo que SÍ queda en "Gastos operativos" es el
// fallback: cargos generales del resumen que el parser ya sabe que son del
// banco (`raw.cargoDelResumen`) pero cuya descripción no matchea ninguno de
// los patrones específicos de abajo.
//
// Solo toca movimientos de tarjeta (source='card') que todavía no tengan
// categoría — correrlo de nuevo más adelante, sobre resúmenes nuevos, es
// seguro: no vuelve a tocar lo que ya quedó categorizado. Para recategorizar
// movimientos que ya tienen el "Gastos operativos" genérico de antes de este
// cambio, usar scripts/split-gastos-operativos.mjs.
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Falta DATABASE_URL. Uso: DATABASE_URL="..." node scripts/categorize-card-fees.mjs [--apply]');
  process.exit(1);
}

const apply = process.argv.includes("--apply");

// Mismos grupos que src/lib/parsers/fee-categories.ts (ese archivo es
// TypeScript, este script es un .mjs plano para poder correrlo con `node`
// directo sin pasar por el build de Next) — si se agrega un patrón nuevo
// acá, hay que agregarlo ahí también.
const FALLBACK_CATEGORY = "Gastos operativos";
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

function detectCategory(description, cargoFlag) {
  const trimmed = description.trim();
  const group = FEE_GROUPS.find((g) => g.patterns.some((re) => re.test(trimmed)));
  if (group) return group.category;
  // Cargo general del resumen, sin patrón específico conocido: fallback genérico.
  return cargoFlag === "true" ? FALLBACK_CATEGORY : null;
}

const sql = postgres(url);

try {
  const rows = await sql`
    select id, date, description, amount, account_ref as "accountRef",
           raw->>'cargoDelResumen' as cargo_flag
    from transactions
    where source = 'card' and category is null
    order by date desc
  `;

  const matched = rows
    .map((r) => ({ ...r, category: detectCategory(r.description, r.cargo_flag) }))
    .filter((r) => r.category !== null);

  if (matched.length === 0) {
    console.log("No hay movimientos de tarjeta sin categorizar que coincidan con los patrones conocidos.");
  } else {
    console.log(`${apply ? "Aplicando" : "Encontrados (dry-run, no se tocó nada)"}: ${matched.length} movimientos\n`);

    const byCategory = new Map();
    for (const r of matched) {
      if (!byCategory.has(r.category)) byCategory.set(r.category, new Map());
      const byDesc = byCategory.get(r.category);
      const key = r.description.trim();
      const g = byDesc.get(key) ?? { count: 0, total: 0 };
      g.count++;
      g.total += Math.abs(Number(r.amount));
      byDesc.set(key, g);
    }
    const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });
    for (const [category, byDesc] of byCategory) {
      console.log(`"${category}":`);
      for (const [desc, g] of [...byDesc.entries()].sort((a, b) => b[1].total - a[1].total)) {
        console.log(`  ${String(g.count).padStart(3)}x  ${fmt.format(g.total).padStart(14)}   ${desc}`);
      }
      console.log("");
    }
    const grandTotal = matched.reduce((acc, r) => acc + Math.abs(Number(r.amount)), 0);
    console.log(`Total: ${fmt.format(grandTotal)} en ${matched.length} movimientos.`);

    if (apply) {
      for (const category of byCategory.keys()) {
        const ids = matched.filter((r) => r.category === category).map((r) => r.id);
        await sql`update transactions set category = ${category} where id = any(${ids})`;
      }
      console.log(`\nListo.`);
    } else {
      console.log('\nEsto fue solo una vista previa. Para aplicarlo de verdad, agregá "--apply" al comando.');
    }
  }
} finally {
  await sql.end();
}
