#!/usr/bin/env node
// Uso:
//   DATABASE_URL="<la de Neon>" node scripts/categorize-card-fees.mjs
//     -> solo MUESTRA qué movimientos marcaría (no toca la base)
//   DATABASE_URL="<la de Neon>" node scripts/categorize-card-fees.mjs --apply
//     -> aplica la categoría de verdad
//   Opcional: --category "Otro nombre" (default: "Gastos operativos")
//
// Categoriza de una sola pasada los cargos típicos que el banco cobra DIRECTO
// en el resumen de tarjeta (IVA, comisiones, sellos, intereses, etc.) — nunca
// van a tener una factura o transferencia con la que cruzar, así que no
// tiene sentido que sigan apareciendo como "sin conciliar". Es exactamente
// el mismo campo `category` que usa el botón manual de /importaciones, así
// que lo que haga este script se ve y se puede deshacer desde ahí también.
//
// Solo toca movimientos de tarjeta (source='card') que todavía no tengan
// categoría — correrlo de nuevo más adelante, sobre resúmenes nuevos, es
// seguro: no vuelve a tocar lo que ya quedó categorizado.
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Falta DATABASE_URL. Uso: DATABASE_URL="..." node scripts/categorize-card-fees.mjs [--apply]');
  process.exit(1);
}

const apply = process.argv.includes("--apply");
const categoryIdx = process.argv.indexOf("--category");
const category = categoryIdx !== -1 ? process.argv[categoryIdx + 1] : "Gastos operativos";

// Patrones conocidos de cargos de resumen de Banco Macro (tarjeta Visa
// Business / Negocios XXI) — conservador a propósito: matchea el PREFIJO
// exacto de cada línea boilerplate, no palabras sueltas, para no agarrar por
// error un consumo real que tenga una de estas palabras en el medio.
const FEE_PATTERNS = [
  /^PERCEP\.?\s*IVA/i,
  /^DB\s*IVA/i,
  /^COMIS\./i, // COMIS.RENOVAC..., COMIS.MANTENIMIENTO, etc.
  /^IMPUESTO\s*DE\s*SELLOS/i,
  /^SELLADO\s*PROVINCIAL/i,
  /^INTERESES?\s*FINANCIACION/i,
  /^PUNIT\./i, // PUNIT.PAG.MIN.ANTERIOR
  /^TRANSFERENCIA\s*DEUDA/i,
];

const sql = postgres(url);

try {
  const rows = await sql`
    select id, date, description, amount, account_ref as "accountRef",
           raw->>'cargoDelResumen' as cargo_flag
    from transactions
    where source = 'card' and category is null
    order by date desc
  `;

  const matched = rows.filter(
    (r) => r.cargo_flag === "true" || FEE_PATTERNS.some((re) => re.test(r.description.trim())),
  );

  if (matched.length === 0) {
    console.log("No hay movimientos de tarjeta sin categorizar que coincidan con los patrones conocidos.");
  } else {
    console.log(`${apply ? "Aplicando" : "Encontrados (dry-run, no se tocó nada)"}: ${matched.length} movimientos\n`);

    const byDesc = new Map();
    for (const r of matched) {
      const key = r.description.trim();
      const g = byDesc.get(key) ?? { count: 0, total: 0 };
      g.count++;
      g.total += Math.abs(Number(r.amount));
      byDesc.set(key, g);
    }
    const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });
    for (const [desc, g] of [...byDesc.entries()].sort((a, b) => b[1].total - a[1].total)) {
      console.log(`  ${String(g.count).padStart(3)}x  ${fmt.format(g.total).padStart(14)}   ${desc}`);
    }
    const grandTotal = matched.reduce((acc, r) => acc + Math.abs(Number(r.amount)), 0);
    console.log(`\nTotal: ${fmt.format(grandTotal)} en ${matched.length} movimientos.`);

    if (apply) {
      const ids = matched.map((r) => r.id);
      await sql`update transactions set category = ${category} where id = any(${ids})`;
      console.log(`\nListo — categorizados como "${category}".`);
    } else {
      console.log('\nEsto fue solo una vista previa. Para aplicarlo de verdad, agregá "--apply" al comando.');
    }
  }
} finally {
  await sql.end();
}
