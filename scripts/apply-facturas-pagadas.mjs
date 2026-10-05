#!/usr/bin/env node
// Uso:
//   DATABASE_URL="<la de Neon>" node scripts/apply-facturas-pagadas.mjs           (solo mira, no cambia nada)
//   DATABASE_URL="<la de Neon>" node scripts/apply-facturas-pagadas.mjs --apply   (concilia de verdad)
//
// Además de las notas puntuales en las pestañas de banco (ver
// apply-sheet-reconciliations.mjs), tu hoja "FACTURAS RECIBIDAS" tenía una
// tilde (TRUE/FALSE) + método de pago para cada comprobante: 581 marcadas
// como ya pagadas (286 por Transferencia, 290 por Tarjeta de crédito, resto
// Efectivo/otro). Esto NO apunta a un movimiento puntual como las notas de
// banco — solo dice "esto se pagó, y por este medio" — así que el cruce acá
// es más laxo: busca, dentro de una ventana de fechas después de la
// factura, un movimiento de 'bank' (si fue Transferencia) o 'card' (si fue
// Tarjeta de crédito) con un importe parecido.
//
// OJO con la trampa que encontramos al analizar esto: Punto de Venta +
// Número NO identifica una factura sola — muchos monotributistas distintos
// numeran cada uno desde PV1-Núm1, así que "C1-15" puede ser de 5
// proveedores diferentes. Por eso el cruce usa SIEMPRE CUIT + PV + Número
// (el CUIT sí está en la planilla), contra el campo `counterparty` que la
// app ya guarda como "<CUIT> - <Razón Social>" en cada comprobante AFIP
// (ver afip-csv.ts) — así no se repite el error.
//
// Datos en `scripts/data/facturas-recibidas-pagadas.json` (581 filas; se
// excluyen "Efectivo" y "otro" porque no hay un movimiento digital que
// buscar — esas se listan aparte, nunca se inventan).
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes("--apply");

// Cuántos días después (y antes, por si el pago quedó cargado con fecha
// previa a la factura) de la fecha de la factura se busca el pago. El pago
// casi siempre es posterior; se deja un margen chico hacia atrás por si hay
// algún desfasaje de carga.
const DIAS_ANTES = 5;
const DIAS_DESPUES = 60;
// Tolerancia de importe: a veces el pago neto difiere del total de la
// factura por una retención (ver el caso real de Casino Puerto Santa Fe) —
// se acepta hasta 25% de diferencia; si hay más de un candidato dentro de
// esa tolerancia, queda ambiguo en vez de adivinar cuál es.
const TOLERANCIA_PCT = 0.25;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Falta DATABASE_URL. Uso: DATABASE_URL="..." node scripts/apply-facturas-pagadas.mjs [--apply]');
  process.exit(1);
}

const dataPath = join(__dirname, "data", "facturas-recibidas-pagadas.json");
const facturas = JSON.parse(readFileSync(dataPath, "utf-8"));

const sql = postgres(url);
const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });
const fmtDate = (d) => new Intl.DateTimeFormat("es-AR", { dateStyle: "short" }).format(new Date(d));

function cuitDigits(counterparty) {
  if (!counterparty) return null;
  const m = counterparty.match(/^(\d[\d-]*)/);
  return m ? m[1].replace(/-/g, "") : null;
}

function descMatchesKey(description, puntoVenta, numero) {
  if (!description) return false;
  const matches = [...description.matchAll(/(\d+)-(\d+)/g)];
  return matches.some(([, pv, num]) => Number(pv) === puntoVenta && Number(num) === numero);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d;
}

try {
  const alreadyMatchedRows = await sql`
    select mi.transaction_id as id
    from match_items mi
    join matches m on m.id = mi.match_id
    where m.status in ('auto', 'confirmed', 'manual')
  `;
  const alreadyMatched = new Set(alreadyMatchedRows.map((r) => r.id));

  const receivedTxns = await sql`select id, date, amount, description, counterparty from transactions where source = 'afip_received'`;
  const bankTxns = await sql`select id, date, amount, description from transactions where source = 'bank'`;
  const cardTxns = await sql`select id, date, amount, description from transactions where source = 'card'`;

  const results = {
    matched: [],
    yaConciliado: [],
    facturaNoEncontrada: [],
    facturaAmbigua: [],
    pagoNoEncontrado: [],
    pagoAmbiguo: [],
    sinMedioDigital: [],
  };

  for (const f of facturas) {
    if (f.metodo !== "transferencia" && f.metodo !== "tarjeta") {
      results.sinMedioDigital.push(f);
      continue;
    }

    const invoiceCandidates = receivedTxns.filter(
      (t) => cuitDigits(t.counterparty) === f.cuit && descMatchesKey(t.description, f.puntoVenta, f.numero),
    );
    if (invoiceCandidates.length === 0) {
      results.facturaNoEncontrada.push(f);
      continue;
    }
    if (invoiceCandidates.length > 1) {
      results.facturaAmbigua.push({ ...f, candidatos: invoiceCandidates.length });
      continue;
    }
    const invoiceTxn = invoiceCandidates[0];

    if (alreadyMatched.has(invoiceTxn.id)) {
      results.yaConciliado.push({ ...f, invoiceTxnId: invoiceTxn.id });
      continue;
    }

    const pool = f.metodo === "transferencia" ? bankTxns : cardTxns;
    const from = addDays(f.date, -DIAS_ANTES);
    const to = addDays(f.date, DIAS_DESPUES);
    const paymentCandidates = pool.filter((t) => {
      if (t.date < from || t.date > to) return false;
      if (alreadyMatched.has(t.id)) return false;
      const diffPct = Math.abs(Math.abs(Number(t.amount)) - f.total) / f.total;
      return diffPct <= TOLERANCIA_PCT;
    });

    if (paymentCandidates.length === 0) {
      results.pagoNoEncontrado.push({ ...f, invoiceTxnId: invoiceTxn.id });
      continue;
    }
    if (paymentCandidates.length > 1) {
      results.pagoAmbiguo.push({ ...f, invoiceTxnId: invoiceTxn.id, candidatos: paymentCandidates.length });
      continue;
    }
    const paymentTxn = paymentCandidates[0];

    results.matched.push({ ...f, invoiceTxn, paymentTxn });
  }

  console.log(`${facturas.length} facturas recibidas marcadas "pagada" en la planilla. Resultado del cruce:\n`);
  console.log(`✓ ${results.matched.length} listas para conciliar`);
  console.log(`· ${results.yaConciliado.length} ya estaban conciliadas (no se tocan)`);
  console.log(`✗ ${results.facturaNoEncontrada.length} sin esa factura en la base (CUIT+PV+Número)`);
  console.log(`✗ ${results.facturaAmbigua.length} con más de una factura candidata (mismo CUIT+PV+Número — revisar a mano)`);
  console.log(`✗ ${results.pagoNoEncontrado.length} sin movimiento de pago dentro de la ventana de fechas/importe`);
  console.log(`✗ ${results.pagoAmbiguo.length} con más de un movimiento de pago candidato`);
  console.log(`- ${results.sinMedioDigital.length} pagadas en Efectivo/otro medio (no hay nada digital para cruzar)\n`);

  if (results.matched.length > 0) {
    console.log("Se van a conciliar:");
    for (const r of results.matched.slice(0, 25)) {
      console.log(
        `  ${r.metodo === "transferencia" ? "TRF" : "TRJ"}  CUIT ${r.cuit} ${r.denominacion}  ${fmtDate(r.date)}  ${fmt.format(r.total)}  factura#${r.invoiceTxn.id} <-> pago#${r.paymentTxn.id} (${fmtDate(r.paymentTxn.date)}, ${fmt.format(r.paymentTxn.amount)})`,
      );
    }
    if (results.matched.length > 25) console.log(`  ... y ${results.matched.length - 25} más`);
    console.log("");
  }

  for (const [label, list] of [
    ["Sin factura en la base", results.facturaNoEncontrada],
    ["Factura ambigua (mismo CUIT+PV+Núm repetido)", results.facturaAmbigua],
    ["Sin movimiento de pago", results.pagoNoEncontrado],
    ["Pago ambiguo", results.pagoAmbiguo],
  ]) {
    if (list.length === 0) continue;
    console.log(`${label} (${list.length}):`);
    for (const r of list.slice(0, 10)) {
      console.log(`  CUIT ${r.cuit} ${r.denominacion}  ${r.tipo} ${r.puntoVenta}-${r.numero}  ${fmtDate(r.date)}  ${fmt.format(r.total)}  [${r.metodo}]`);
    }
    if (list.length > 10) console.log(`  ... y ${list.length - 10} más`);
    console.log("");
  }

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
    console.log(`  DATABASE_URL="..." node scripts/apply-facturas-pagadas.mjs --apply`);
  } else if (results.matched.length === 0) {
    console.log("Nada para conciliar.");
  } else {
    for (const r of results.matched) {
      const amountDiff = (Math.abs(r.paymentTxn.amount) - r.total).toFixed(2);
      const [match] = await sql`
        insert into matches (status, strategy, confidence, amount_diff, note)
        values ('manual', 'manual', 90, ${amountDiff}, ${`Importado desde hoja "FACTURAS RECIBIDAS" (fila ${r.row}) — ${r.denominacion}, pagada por ${r.metodo}`})
        returning id
      `;
      await sql`
        insert into match_items (match_id, transaction_id) values
        (${match.id}, ${r.invoiceTxn.id}),
        (${match.id}, ${r.paymentTxn.id})
      `;
    }
    const pctDespues = await conciliadoPct();
    console.log(`Conciliados ${results.matched.length} movimiento(s).`);
    console.log(`% conciliado: ${pctAntes}% -> ${pctDespues}%`);
  }
} finally {
  await sql.end();
}
