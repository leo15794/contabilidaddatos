#!/usr/bin/env node
// Uso:
//   DATABASE_URL="<la de Neon>" node scripts/debug-partner-matching.mjs
//
// Diagnóstico de por qué el dashboard de Socios no suma algún gasto: lista
// los socios cargados y, al lado, TODOS los nombres de titular distintos que
// aparecen en los resúmenes de tarjeta ya importados (columna
// raw->>'cardholder' de `transactions`), con cuántos movimientos y cuánta
// plata tiene cada uno. Marca con ✓ los que matchean exacto con algún socio
// (mismo criterio que usa la app: sin importar mayúsculas/espacios) y con ✗
// los que no — esos ✗ son probablemente el motivo de la diferencia: un
// titular real que no tiene socio cargado todavía, o un socio cuyo nombre no
// está escrito igual que como lo imprime el banco.
//
// No modifica nada — solo lee y muestra.
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Falta DATABASE_URL. Uso: DATABASE_URL="..." node scripts/debug-partner-matching.mjs');
  process.exit(1);
}

function normalize(name) {
  return name.trim().replace(/\s+/g, " ").toUpperCase();
}

const sql = postgres(url);

try {
  const partners = await sql`select id, name, phone from partners order by name`;
  const cardholders = await sql`
    select raw->>'cardholder' as cardholder, count(*)::int as count, sum(abs(amount))::numeric(14,2) as total
    from transactions
    where source = 'card' and raw->>'cardholder' is not null
    group by 1
    order by 3 desc
  `;

  console.log(`Socios cargados (${partners.length}):`);
  if (partners.length === 0) {
    console.log("  (ninguno)");
  }
  for (const p of partners) {
    console.log(`  - "${p.name}"  (normalizado: "${normalize(p.name)}")${p.phone ? `  tel: ${p.phone}` : ""}`);
  }

  const partnerNormSet = new Set(partners.map((p) => normalize(p.name)));
  const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });

  console.log(`\nTitulares encontrados en resúmenes de tarjeta ya importados (${cardholders.length}):`);
  if (cardholders.length === 0) {
    console.log("  (ninguno — no hay transacciones de tarjeta con raw->>'cardholder' cargado)");
  }
  for (const c of cardholders) {
    const norm = normalize(c.cardholder);
    const match = partnerNormSet.has(norm);
    console.log(
      `  ${match ? "✓" : "✗"} "${c.cardholder}"  ->  ${c.count} mov.  ${fmt.format(Number(c.total)).padStart(14)}${
        match ? "" : "   <-- sin socio que coincida"
      }`,
    );
  }

  const unmatched = cardholders.filter((c) => !partnerNormSet.has(normalize(c.cardholder)));
  if (unmatched.length > 0) {
    console.log(
      `\n${unmatched.length} titular(es) con movimientos pero sin socio que coincida exacto. Si alguno de estos es en realidad un socio ya cargado, el nombre del socio en /socios tiene que decir EXACTAMENTE igual (podés editarlo, o cargar uno nuevo con ese texto tal cual).`,
    );
  } else if (cardholders.length > 0) {
    console.log("\nTodos los titulares encontrados coinciden con algún socio cargado.");
  }
} finally {
  await sql.end();
}
