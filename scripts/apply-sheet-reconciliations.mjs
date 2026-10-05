#!/usr/bin/env node
// Uso:
//   DATABASE_URL="<la de Neon>" node scripts/apply-sheet-reconciliations.mjs           (solo mira, no cambia nada)
//   DATABASE_URL="<la de Neon>" node scripts/apply-sheet-reconciliations.mjs --apply   (concilia de verdad)
//
// Tu hoja de Google Sheets "Banco Macro" tenía, al lado de cada movimiento
// bancario (pestañas "Especial <mes>" / "Cta. Cte. <mes>", feb 2025 a ago
// 2026), una anotación a mano con qué factura correspondía — la mayoría con
// el formato "<Tipo>-<PuntoVenta>-<Número>" (ej. "A-1-5", "C1-26",
// "B-1-79"). Esas son conciliaciones que ya hiciste vos, a mano, antes de
// que existiera esta app — este script las trae para acá en vez de que
// tengas que rehacerlas de nuevo pestaña por pestaña.
//
// Extraídas a `scripts/data/sheet-invoice-keys.json` (112 anotaciones con
// formato de clave reconocible — se descartaron ~4 celdas con texto mezclado
// tipo "C1-163 C1-164" y las que eran solo nombre de cliente/proveedor sin
// número de factura, esas quedan para otra pasada aparte).
//
// Cómo matchea cada fila:
//   1. Busca el movimiento de BANCO: misma fecha y mismo importe que figuran
//      en la hoja (tienen que ser exactamente el mismo movimiento que ya
//      importaste del extracto real).
//   2. Busca la FACTURA: AFIP emitida si el importe es positivo (ingreso),
//      recibida si es negativo (egreso) — y dentro de esa fuente, la que
//      tenga "<PuntoVenta>-<Número>" en su descripción (así se arma la
//      descripción al importar, ver src/lib/parsers/afip-csv.ts — no hace
//      falta adivinar el nombre de columna del CSV).
//   3. Si encuentra exactamente UNA de cada lado, y ninguna de las dos ya
//      está en otro match confirmado/manual/auto, las concilia. Si hay 0 o
//      más de 1 candidato, la deja afuera y la lista en "sin resolver" /
//      "ambiguas" para que la revises a mano — nunca adivina.
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes("--apply");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Falta DATABASE_URL. Uso: DATABASE_URL="..." node scripts/apply-sheet-reconciliations.mjs [--apply]');
  process.exit(1);
}

const keysPath = join(__dirname, "data", "sheet-invoice-keys.json");
const keys = JSON.parse(readFileSync(keysPath, "utf-8"));

const sql = postgres(url);
const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });
const fmtDate = (d) => new Intl.DateTimeFormat("es-AR", { dateStyle: "short" }).format(new Date(d));

// Extrae "<puntoVenta>-<numero>" de la descripción que arma el parser AFIP
// (ver afip-csv.ts: `[tipo, "<pv>-<num>", razonSocial].join(" · ")`) y lo
// compara como número (así da igual si el CSV tenía ceros a la izquierda).
function descMatchesKey(description, puntoVenta, numero) {
  if (!description) return false;
  const matches = [...description.matchAll(/(\d+)-(\d+)/g)];
  return matches.some(([, pv, num]) => Number(pv) === puntoVenta && Number(num) === numero);
}

try {
  // Ya conciliados (cualquier status que cuenta como "resuelto") — para no
  // tocar una transacción que ya tiene su match, y para poder recalcular el
  // % de conciliación antes/después.
  const alreadyMatchedRows = await sql`
    select mi.transaction_id as id
    from match_items mi
    join matches m on m.id = mi.match_id
    where m.status in ('auto', 'confirmed', 'manual')
  `;
  const alreadyMatched = new Set(alreadyMatchedRows.map((r) => r.id));

  const bankTxns = await sql`select id, date, amount, description from transactions where source = 'bank'`;
  const issuedTxns = await sql`select id, date, amount, description from transactions where source = 'afip_issued'`;
  const receivedTxns = await sql`select id, date, amount, description from transactions where source = 'afip_received'`;

  const results = { matched: [], yaConciliado: [], bancoNoEncontrado: [], bancoAmbiguo: [], facturaNoEncontrada: [], facturaAmbigua: [] };

  for (const k of keys) {
    const dayStart = new Date(k.date + "T00:00:00");
    const dayEnd = new Date(k.date + "T23:59:59");

    const bankCandidates = bankTxns.filter(
      (t) => t.date >= dayStart && t.date <= dayEnd && Math.abs(Number(t.amount) - k.amount) < 0.01,
    );
    if (bankCandidates.length === 0) {
      results.bancoNoEncontrado.push(k);
      continue;
    }
    if (bankCandidates.length > 1) {
      results.bancoAmbiguo.push({ ...k, candidatos: bankCandidates.length });
      continue;
    }
    const bankTxn = bankCandidates[0];

    const pool = k.amount >= 0 ? issuedTxns : receivedTxns;
    const invoiceCandidates = pool.filter((t) => descMatchesKey(t.description, k.puntoVenta, k.numero));
    if (invoiceCandidates.length === 0) {
      results.facturaNoEncontrada.push(k);
      continue;
    }
    if (invoiceCandidates.length > 1) {
      results.facturaAmbigua.push({ ...k, candidatos: invoiceCandidates.length });
      continue;
    }
    const invoiceTxn = invoiceCandidates[0];

    if (alreadyMatched.has(bankTxn.id) || alreadyMatched.has(invoiceTxn.id)) {
      results.yaConciliado.push({ ...k, bankTxnId: bankTxn.id, invoiceTxnId: invoiceTxn.id });
      continue;
    }

    results.matched.push({ ...k, bankTxn, invoiceTxn });
  }

  console.log(`${keys.length} anotaciones de la hoja. Resultado del cruce:\n`);
  console.log(`✓ ${results.matched.length} listas para conciliar (banco único + factura única, ninguna ya conciliada)`);
  console.log(`· ${results.yaConciliado.length} ya estaban conciliadas (no se tocan)`);
  console.log(`✗ ${results.bancoNoEncontrado.length} sin el movimiento de banco en la base`);
  console.log(`✗ ${results.bancoAmbiguo.length} con más de un movimiento de banco candidato`);
  console.log(`✗ ${results.facturaNoEncontrada.length} sin la factura AFIP correspondiente en la base`);
  console.log(`✗ ${results.facturaAmbigua.length} con más de una factura candidata (mismo PV-Número)\n`);

  if (results.matched.length > 0) {
    console.log("Se van a conciliar:");
    for (const r of results.matched.slice(0, 25)) {
      console.log(
        `  ${r.key_raw}  ${fmtDate(r.date)}  ${fmt.format(r.amount)}  banco#${r.bankTxn.id} <-> factura#${r.invoiceTxn.id}  (${r.invoiceTxn.description})`,
      );
    }
    if (results.matched.length > 25) console.log(`  ... y ${results.matched.length - 25} más`);
    console.log("");
  }

  for (const [label, list] of [
    ["Sin movimiento de banco", results.bancoNoEncontrado],
    ["Banco ambiguo", results.bancoAmbiguo],
    ["Sin factura AFIP", results.facturaNoEncontrada],
    ["Factura ambigua", results.facturaAmbigua],
  ]) {
    if (list.length === 0) continue;
    console.log(`${label} (${list.length}):`);
    for (const r of list.slice(0, 10)) {
      console.log(`  ${r.key_raw}  ${fmtDate(r.date)}  ${fmt.format(r.amount)}  "${r.description}"  [hoja: ${r.tab}, fila ${r.row}]`);
    }
    if (list.length > 10) console.log(`  ... y ${list.length - 10} más`);
    console.log("");
  }

  // % de conciliación antes (y, en --apply, después) — misma fórmula que el dashboard.
  async function conciliadoPct() {
    const [{ total }] = await sql`select count(*)::int as total from transactions`;
    const [{ categorizados }] = await sql`select count(*)::int as categorizados from transactions where category is not null`;
    const [{ conciliados }] = await sql`
      select count(distinct mi.transaction_id)::int as conciliados
      from match_items mi
      join matches m on m.id = mi.match_id
      where m.status in ('auto', 'confirmed', 'manual')
    `;
    const denom = total - categorizados;
    return denom <= 0 ? 100 : Math.round((conciliados / denom) * 100);
  }

  const pctAntes = await conciliadoPct();

  if (!APPLY) {
    console.log(`% conciliado actual: ${pctAntes}%`);
    console.log(`\nEsto fue solo una vista previa — no se cambió nada. Para conciliar los ${results.matched.length} de arriba, corré:`);
    console.log(`  DATABASE_URL="..." node scripts/apply-sheet-reconciliations.mjs --apply`);
  } else if (results.matched.length === 0) {
    console.log("Nada para conciliar.");
  } else {
    for (const r of results.matched) {
      const amountDiff = (Math.abs(r.bankTxn.amount) - Math.abs(r.invoiceTxn.amount)).toFixed(2);
      const [match] = await sql`
        insert into matches (status, strategy, confidence, amount_diff, note)
        values ('manual', 'manual', 100, ${amountDiff}, ${`Importado desde hoja de cálculo "Banco Macro" (${r.tab}, fila ${r.row}) — clave ${r.key_raw}`})
        returning id
      `;
      await sql`
        insert into match_items (match_id, transaction_id) values
        (${match.id}, ${r.bankTxn.id}),
        (${match.id}, ${r.invoiceTxn.id})
      `;
    }
    const pctDespues = await conciliadoPct();
    console.log(`Conciliados ${results.matched.length} movimiento(s).`);
    console.log(`% conciliado: ${pctAntes}% -> ${pctDespues}%`);
  }
} finally {
  await sql.end();
}
