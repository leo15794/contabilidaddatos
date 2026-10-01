// Carga como matches "manual" confirmados los cruces factura-pago que Leo ya
// había hecho a mano en la planilla de Google Sheets (columnas sueltas tipo
// "A1-3159" + "MIJO SRL" al lado de cada movimiento bancario).
//
// Por cada fila de scripts/data/bank-invoice-refs.json:
//   1. Decodifica la referencia "A-3-1754" -> {tipo: "A", ptoVta: 3, numero: 1754}
//   2. Busca en la tabla transactions (source afip_issued/afip_received) la
//      factura con ese tipo/punto de venta/número.
//   3. Busca el movimiento bancario correspondiente por pestaña+fecha+importe.
//   4. Si ambos lados existen, son únicos, y ninguno ya está en un match
//      (status != 'rejected'), crea un match strategy='manual' status='manual'.
//
// Por default corre en modo DRY RUN (no escribe nada), solo imprime qué haría.
// Para aplicar de verdad: `node scripts/seed-manual-matches.mjs --apply`
//
// Requiere DATABASE_URL en el entorno (igual que los otros scripts de scripts/).

import postgres from "postgres";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const APPLY = process.argv.includes("--apply");
const DIAG = process.argv.includes("--diag");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("Falta DATABASE_URL en el entorno.");
  process.exit(1);
}

const sql = postgres(connectionString, { max: 1 });

if (DIAG) {
  // Diagnóstico rápido: cuántas facturas hay realmente cargadas y qué pinta
  // tiene el campo crudo, para confirmar que coincide con lo que asume el
  // resto del script antes de seguir afinando la lógica de match.
  const counts = await sql`select source, count(*) from transactions where source in ('afip_issued','afip_received') group by source`;
  console.log("Conteo por fuente:", counts);
  const sample = await sql`
    select source, raw->>'Tipo de Comprobante' as tipo, raw->>'Punto de Venta' as pv, raw->>'Numero Desde' as num, amount
    from transactions
    where source in ('afip_issued','afip_received')
    order by random()
    limit 10
  `;
  console.log("Muestra de 10 facturas al azar:");
  for (const s of sample) console.log(" ", s);
  await sql.end();
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const refs = JSON.parse(
  readFileSync(path.join(__dirname, "data", "bank-invoice-refs.json"), "utf-8"),
);

// "A-3-1754" / "A1-3159" / "C-157-158" -> { tipo: "A", ptoVta: 3, numero: 1754 }
function decodeRef(ref) {
  const m = ref.trim().match(/^([A-Za-z])\s*-?\s*(\d{1,3})[\s-](\d{1,7})$/);
  if (!m) return null;
  return { tipo: m[1].toUpperCase(), ptoVta: Number(m[2]), numero: Number(m[3]) };
}

function parseArDate(ddmmyyyy) {
  // "29/07/2026" -> Date (sin hora, igual que se guardan los movimientos)
  const [d, m, y] = ddmmyyyy.split("/").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function sameDay(a, b) {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

const LEGAL_SUFFIXES = /\b(SRL|S\.R\.L|SA|S\.A|SOCIEDAD\s+ANONIMA|SOCIEDAD\s+DE\s+RESPONSABILIDAD\s+LIMITADA|UTE|U\.T\.E|LTDA)\b/g;
const STOPWORDS = new Set(["DE", "DEL", "LA", "EL", "LOS", "LAS", "Y", "CON"]);

function normalizeName(s) {
  if (!s) return [];
  const clean = s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(LEGAL_SUFFIXES, " ");
  return clean
    .split(/[^A-Z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

// Solapamiento de palabras entre dos nombres, relativo al más corto de los
// dos (así una descripción larga y ruidosa que contiene el nombre real del
// proveedor igual puntúa alto).
function nameOverlap(a, b) {
  const wa = new Set(normalizeName(a));
  const wb = new Set(normalizeName(b));
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / Math.min(wa.size, wb.size);
}

let created = 0;
let createdByRef = 0;
let createdByName = 0;
let skippedNoDecode = 0;
let skippedNoInvoice = 0;
let skippedAmbiguousInvoice = 0;
let skippedNoBankTxn = 0;
let skippedAmbiguousBankTxn = 0;
let skippedAlreadyMatched = 0;
const reviewLog = [];

console.log(`Procesando ${refs.length} referencias${APPLY ? " (APLICANDO)" : " (dry run, no se escribe nada)"}...\n`);

for (const row of refs) {
  const decoded = decodeRef(row.ref);
  if (!decoded) {
    skippedNoDecode++;
    reviewLog.push({ row, reason: "no se pudo decodificar la referencia" });
    continue;
  }

  // --- lado factura (AFIP emitida o recibida) ---
  // "Tipo de Comprobante" en el CSV de AFIP viene como "1 - Factura A", "6 -
  // Factura B", etc. (no arranca con la letra), y "Punto de Venta"/"Numero
  // Desde" pueden venir como texto numérico con decimales ("1.0", "16.0").
  //
  // El punto de venta/número de comprobante NO es único entre emitidas y
  // recibidas (cada empresa numera independiente), así que para no mezclar
  // facturas de cobro con facturas de pago se filtra también por el signo
  // del movimiento: un egreso bancario (importe negativo) solo puede ser una
  // factura recibida (pago a un proveedor), un ingreso solo una emitida.
  const expectedSource = row.importe < 0 ? "afip_received" : "afip_issued";
  const invoiceCandidates = await sql`
    select id, source, amount, raw, counterparty
    from transactions
    where source = ${expectedSource}
      and upper(coalesce(raw->>'Tipo de Comprobante', '')) like ${"%FACTURA " + decoded.tipo + "%"}
      and (
        (raw->>'Punto de Venta') ~ '^\\d+(\\.\\d+)?$'
        and (raw->>'Punto de Venta')::numeric::int = ${decoded.ptoVta}
      )
      and (
        (raw->>'Numero Desde') ~ '^\\d+(\\.\\d+)?$'
        and (raw->>'Numero Desde')::numeric::int = ${decoded.numero}
      )
  `;

  let invoice;
  let matchedByName = false;

  if (invoiceCandidates.length === 1) {
    invoice = invoiceCandidates[0];
  } else if (invoiceCandidates.length > 1) {
    // Varias facturas con el mismo tipo/pto vta/número (poco común, pero
    // pasa si hay reimportaciones o notas de crédito asociadas): se
    // desempata por el importe más cercano al movimiento bancario.
    const sorted = [...invoiceCandidates].sort(
      (a, b) =>
        Math.abs(Math.abs(Number(a.amount)) - Math.abs(row.importe)) -
        Math.abs(Math.abs(Number(b.amount)) - Math.abs(row.importe)),
    );
    const best = sorted[0];
    const bestDiff = Math.abs(Math.abs(Number(best.amount)) - Math.abs(row.importe));
    const secondDiff = sorted[1]
      ? Math.abs(Math.abs(Number(sorted[1].amount)) - Math.abs(row.importe))
      : Infinity;
    if (bestDiff <= 0.01 && secondDiff > 0.01) {
      invoice = best;
    }
  }

  // --- fallback: nombre de la contraparte + importe ---
  // Cuando el número de comprobante no alcanza (no se encontró, o quedó
  // ambiguo), Leo prefiere que se resuelva por nombre + monto, que es lo que
  // realmente identifica el cruce: misma plata, mismo proveedor/cliente.
  if (!invoice) {
    const nameCandidates = await sql`
      select id, source, amount, raw, counterparty
      from transactions
      where source = ${expectedSource}
        and abs(abs(amount) - abs(${row.importe})) <= greatest(1, abs(${row.importe}) * 0.005)
    `;
    const denomKey = expectedSource === "afip_received" ? "Denominacion Emisor" : "Denominacion Receptor";
    const scored = nameCandidates
      .map((c) => ({ c, score: nameOverlap(row.counterparty, c.raw?.[denomKey] ?? c.counterparty ?? "") }))
      .filter((s) => s.score >= 0.5)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 1 || (scored.length > 1 && scored[0].score > scored[1].score)) {
      invoice = scored[0].c;
      matchedByName = true;
    } else if (scored.length > 1) {
      skippedAmbiguousInvoice++;
      reviewLog.push({
        row,
        decoded,
        expectedSource,
        reason: `ref no resolvió, y por nombre+monto quedaron ${scored.length} candidatos empatados`,
        candidateIds: scored.map((s) => s.c.id),
      });
      continue;
    }
  }

  if (!invoice) {
    skippedNoInvoice++;
    reviewLog.push({ row, decoded, expectedSource, reason: "no se encontró la factura ni por número de comprobante ni por nombre+monto" });
    continue;
  }

  // --- lado banco: misma pestaña + fecha + importe ---
  const fecha = parseArDate(row.fecha);
  const bankCandidates = await sql`
    select id, date, amount, raw
    from transactions
    where source = 'bank'
      and raw->>'Pestana' = ${row.sheet}
      and abs(amount - ${row.importe}) < 0.01
  `;
  const bankMatches = bankCandidates.filter((t) => sameDay(new Date(t.date), fecha));

  if (bankMatches.length === 0) {
    skippedNoBankTxn++;
    reviewLog.push({ row, decoded, invoiceId: invoice.id, reason: "no se encontró el movimiento bancario (pestaña+fecha+importe)" });
    continue;
  }
  if (bankMatches.length > 1) {
    skippedAmbiguousBankTxn++;
    reviewLog.push({ row, decoded, invoiceId: invoice.id, reason: `${bankMatches.length} movimientos bancarios candidatos, ambiguo` });
    continue;
  }
  const bankTxn = bankMatches[0];

  // --- ¿ya están en un match no-rechazado? ---
  const existing = await sql`
    select mi.transaction_id, m.status
    from match_items mi
    join matches m on m.id = mi.match_id
    where mi.transaction_id in (${invoice.id}, ${bankTxn.id})
      and m.status != 'rejected'
  `;
  if (existing.length > 0) {
    skippedAlreadyMatched++;
    reviewLog.push({ row, decoded, invoiceId: invoice.id, bankTxnId: bankTxn.id, reason: "alguno de los dos ya tiene un match activo" });
    continue;
  }

  const amountDiff = Math.abs(Math.abs(Number(invoice.amount)) - Math.abs(Number(bankTxn.amount)));
  const via = matchedByName ? "nombre+monto" : "nro. comprobante";

  if (APPLY) {
    const [m] = await sql`
      insert into matches (status, strategy, confidence, amount_diff, note)
      values ('manual', 'manual', 100, ${amountDiff.toFixed(2)}, ${`Cruce manual de Leo (planilla), resuelto por ${via}: ref ${row.ref} · ${row.counterparty ?? ""}`})
      returning id
    `;
    await sql`
      insert into match_items (match_id, transaction_id)
      values (${m.id}, ${invoice.id}), (${m.id}, ${bankTxn.id})
    `;
  }
  created++;
  if (matchedByName) createdByName++;
  else createdByRef++;
  console.log(
    `${APPLY ? "OK" : "[dry-run]"} [${via}] ${row.ref} (${row.counterparty ?? "?"}) -> factura #${invoice.id} <-> banco #${bankTxn.id} (diff $${amountDiff.toFixed(2)})`,
  );
}

console.log("\n--- Resumen ---");
console.log("Matches creados" + (APPLY ? "" : " (simulados)") + ":", created, `(por nro. comprobante: ${createdByRef}, por nombre+monto: ${createdByName})`);
console.log("Sin decodificar la referencia:", skippedNoDecode);
console.log("Factura no encontrada (ni por número ni por nombre+monto):", skippedNoInvoice);
console.log("Factura ambigua:", skippedAmbiguousInvoice);
console.log("Movimiento bancario no encontrado:", skippedNoBankTxn);
console.log("Movimiento bancario ambiguo (>1 candidato):", skippedAmbiguousBankTxn);
console.log("Ya tenían un match activo:", skippedAlreadyMatched);

if (reviewLog.length > 0) {
  const { writeFileSync } = await import("node:fs");
  const outPath = path.join(__dirname, "data", "seed-manual-matches-review.json");
  writeFileSync(outPath, JSON.stringify(reviewLog, null, 2), "utf-8");
  console.log(`\nCasos para revisar a mano guardados en: ${outPath}`);
}

if (!APPLY) {
  console.log("\nEsto fue un dry run. Si los números tienen sentido, corré:");
  console.log("  node scripts/seed-manual-matches.mjs --apply");
}

await sql.end();
