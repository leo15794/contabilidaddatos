#!/usr/bin/env node
// Uso:
//   DATABASE_URL="<la de Neon>" node scripts/review-fuzzy-matches.mjs           (solo mira, no cambia nada)
//   DATABASE_URL="<la de Neon>" node scripts/review-fuzzy-matches.mjs --apply   (rechaza los que no pasan la regla nueva)
//
// Repasa los matches "fuzzy" que están "pending" (sugerencias del motor,
// todavía sin confirmar en /review) y les vuelve a aplicar el criterio nuevo
// de src/lib/matching/engine.ts (el que arregló el falso positivo de
// BOLDT SA vs. YPF: ya no alcanza con que el importe se parezca, tiene que
// haber alguna palabra en común entre descripción/contraparte, y el umbral
// de score subió).
//
// Los que NO pasarían más con la regla nueva se marcan como "BAD" acá abajo.
// Sin --apply, solo se listan (no se toca la base). Con --apply, esos "BAD"
// se pasan a status='rejected' (no se borran — quedan igual que si vos
// hubieras tocado "Rechazar" a mano en /review, y siguen viéndose en
// /conciliados como rechazados, reversible desde ahí si alguno en realidad
// estaba bien). Los "confirmed"/"manual" nunca se tocan.
import postgres from "postgres";

const APPLY = process.argv.includes("--apply");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Falta DATABASE_URL. Uso: DATABASE_URL="..." node scripts/review-fuzzy-matches.mjs [--apply]');
  process.exit(1);
}

// --- misma lógica que src/lib/matching/text-similarity.ts y engine.ts ---
function tokenize(text) {
  return new Set(
    text
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
}

function jaccardSimilarity(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const FUZZY_AMOUNT_TOLERANCE_PCT = 0.02; // igual que DEFAULTS.fuzzyAmountTolerancePct en engine.ts

function evaluate(a, b) {
  const amountA = Number(a.amount);
  const amountB = Number(b.amount);
  const pctDiff = Math.abs(Math.abs(amountA) - Math.abs(amountB)) / Math.max(Math.abs(amountA), 0.01);

  if (pctDiff > FUZZY_AMOUNT_TOLERANCE_PCT * 2) {
    return { ok: false, reason: `importe difiere ${(pctDiff * 100).toFixed(1)}% (> 4%)`, score: 0 };
  }

  const textScore = jaccardSimilarity(`${a.description} ${a.counterparty ?? ""}`, `${b.description} ${b.counterparty ?? ""}`);
  if (textScore <= 0) {
    return { ok: false, reason: "sin ninguna palabra en común entre descripción/contraparte", score: 0 };
  }

  const amountScore = 1 - Math.min(pctDiff / (FUZZY_AMOUNT_TOLERANCE_PCT * 2), 1);
  const score = textScore * 0.6 + amountScore * 0.4;

  if (score <= 0.35) {
    return { ok: false, reason: `score ${score.toFixed(2)} (<= 0.35)`, score };
  }

  return { ok: true, reason: `score ${score.toFixed(2)}`, score };
}

const sql = postgres(url);
const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });
const fmtDate = (d) => new Intl.DateTimeFormat("es-AR", { dateStyle: "short" }).format(new Date(d));

try {
  const pendingFuzzy = await sql`
    select id from matches where strategy = 'fuzzy' and status = 'pending' order by id
  `;

  if (pendingFuzzy.length === 0) {
    console.log("No hay matches fuzzy pending para repasar.");
    process.exit(0);
  }

  console.log(`Repasando ${pendingFuzzy.length} match(es) fuzzy pendientes con la regla nueva...\n`);

  const bad = [];
  const good = [];

  for (const { id: matchId } of pendingFuzzy) {
    const items = await sql`
      select t.id, t.source, t.date, t.description, t.amount, t.counterparty
      from match_items mi
      join transactions t on t.id = mi.transaction_id
      where mi.match_id = ${matchId}
      order by t.id
    `;

    if (items.length !== 2) {
      console.log(`#${matchId}: tiene ${items.length} transacciones (no 2) — se deja como está, no es el caso típico fuzzy.\n`);
      continue;
    }

    const [a, b] = items;
    const verdict = evaluate(a, b);
    const label = `${a.source}·${fmtDate(a.date)} ${a.description} (${fmt.format(Number(a.amount))})  <->  ${b.source}·${fmtDate(b.date)} ${b.description} (${fmt.format(Number(b.amount))})`;

    if (verdict.ok) {
      console.log(`✓ #${matchId} OK (${verdict.reason})\n  ${label}\n`);
      good.push(matchId);
    } else {
      console.log(`✗ #${matchId} BAD — ${verdict.reason}\n  ${label}\n`);
      bad.push(matchId);
    }
  }

  console.log(`\nResumen: ${good.length} siguen OK, ${bad.length} ya no pasarían con la regla nueva.`);

  if (bad.length === 0) {
    console.log("Nada para rechazar.");
  } else if (!APPLY) {
    console.log(`\nEsto fue solo una vista previa — no se cambió nada. Para rechazar los ${bad.length} marcados BAD, corré:`);
    console.log(`  DATABASE_URL="..." node scripts/review-fuzzy-matches.mjs --apply`);
  } else {
    await sql`
      update matches set status = 'rejected', resolved_at = now()
      where id = any(${bad})
    `;
    console.log(`\nRechazados ${bad.length} match(es) (status -> 'rejected'). Los ${good.length} que siguen OK quedaron igual, pendientes de tu revisión manual en /review.`);
  }
} finally {
  await sql.end();
}
