#!/usr/bin/env node
// Uso (una sola vez, después de desplegar el fix de exclusiones):
//   DATABASE_URL="<la de Neon>" node scripts/reset-bad-matches.mjs
//
// Borra los matches "pending" (sugerencias sin confirmar) y "auto"
// (confirmados solos por el motor) — NUNCA toca "confirmed"/"manual", que son
// decisiones tuyas. Los deja como no-matcheados para que el botón
// "Re-conciliar" del dashboard los vuelva a procesar, ya con la regla nueva
// que excluye impuestos/comisiones/transferencias entre cuentas propias.
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Falta DATABASE_URL. Uso: DATABASE_URL=\"...\" node scripts/reset-bad-matches.mjs");
  process.exit(1);
}

const sql = postgres(url);

try {
  const toDelete = await sql`select id from matches where status in ('pending', 'auto')`;
  const ids = toDelete.map((m) => m.id);

  if (ids.length === 0) {
    console.log("No hay matches pending/auto para borrar.");
  } else {
    await sql`delete from match_items where match_id = any(${ids})`;
    await sql`delete from matches where id = any(${ids})`;
    console.log(`Borrados ${ids.length} matches (pending + auto). Los "confirmed"/"manual" quedaron intactos.`);
    console.log('Ahora entrá a /dashboard y apretá "Re-conciliar" para que se vuelvan a generar, ya sin los falsos positivos.');
  }
} finally {
  await sql.end();
}
