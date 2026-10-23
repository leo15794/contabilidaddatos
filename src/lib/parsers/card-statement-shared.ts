import { ParsedRow, parseArDate } from "./types";
import { DEFAULT_FEE_CATEGORY, detectFeeCategory } from "./fee-categories";

/**
 * Forma común de "ya extraje un resumen de tarjeta Visa Business/Negocios
 * XXI de Banco Macro, con sus tarjetas adicionales y subtotales" — sin
 * importar si quien lo extrajo fue Claude leyendo el PDF visualmente
 * (`card-pdf-vision.ts`) o una planilla Excel cargada a mano
 * (`card-xlsx.ts`). Ambos parsers arman esto y después llaman a
 * `buildRowsFromExtraction`, así la lógica de checksum por tarjeta vive en
 * un solo lugar.
 */
export type CardholderExtraction = {
  cardNumber: string;
  name: string;
  subtotalImpreso: number;
  consumos: {
    fecha: string;
    comprobante: string;
    descripcion: string;
    cuotas: string | null;
    importe: number;
  }[];
};

export type StatementExtraction = {
  emisor: string | null;
  cierre: string | null;
  vencimiento: string | null;
  saldoAnterior: number | null;
  saldoActual: number | null;
  pagoMinimo: number | null;
  cargosVarios: { descripcion: string; importe: number }[];
  cardholders: CardholderExtraction[];
};

// "27 Marzo 26" -> "27/03/2026" (parseArDate ya sabe parsear dd/mm/yyyy).
// Si la fecha ya viene como dd/mm/aaaa (ej. desde una planilla Excel), esta
// función la deja pasar sin tocarla.
// Incluye las abreviaturas de 3 letras en español ("Dic", "Ago", "Ene", "Abr",
// "Set"): el lector de PDF las devuelve así ("24 Dic 25"), y `new Date()` de JS
// solo entiende las inglesas ("Dec", "Aug"), así que sin esto el cierre no se
// interpretaba y los cargos del resumen quedaban con la fecha del día de carga.
const MESES: Record<string, string> = {
  enero: "01", febrero: "02", marzo: "03", abril: "04", mayo: "05", junio: "06",
  julio: "07", agosto: "08", septiembre: "09", setiembre: "09", octubre: "10",
  noviembre: "11", diciembre: "12",
  ene: "01", feb: "02", mar: "03", abr: "04", may: "05", jun: "06",
  jul: "07", ago: "08", sep: "09", set: "09", oct: "10", nov: "11", dic: "12",
};

export function normalizeFecha(fecha: string): string {
  const m = fecha.trim().toLowerCase().match(/^(\d{1,2})\s+([a-záéíóú]+)\.?\s+(\d{2,4})$/);
  if (!m) return fecha;
  const [, day, mesRaw, yearRaw] = m;
  const mes = MESES[mesRaw] ?? MESES[mesRaw.slice(0, 3)];
  if (!mes) return fecha;
  const year = yearRaw.length === 2 ? `20${yearRaw}` : yearRaw;
  return `${day.padStart(2, "0")}/${mes}/${year}`;
}

/**
 * Convierte una `StatementExtraction` (venga de donde venga) en filas
 * `ParsedRow` listas para guardar, validando el checksum de cada tarjeta
 * (suma de consumos extraídos vs. el subtotal impreso en el resumen) y
 * marcando para revisión manual la que no cierre.
 */
export function buildRowsFromExtraction(extraction: StatementExtraction): {
  rows: ParsedRow[];
  warnings: string[];
  needsReview: boolean;
  reviewNotes: string[];
} {
  const warnings: string[] = [];
  const reviewNotes: string[] = [];
  let needsReview = false;
  const rows: ParsedRow[] = [];

  const cierreDate = parseArDate(normalizeFecha(extraction.cierre ?? ""));
  if (!cierreDate && extraction.cierre) {
    warnings.push(`No se pudo interpretar la fecha de cierre "${extraction.cierre}" — los cargos del resumen toman la fecha del último consumo.`);
  }

  for (const ch of extraction.cardholders ?? []) {
    const sum = ch.consumos.reduce((acc, c) => acc + c.importe, 0);
    const diff = Math.abs(sum - ch.subtotalImpreso);
    const checksumOk = diff < 1;
    if (!checksumOk) {
      needsReview = true;
      reviewNotes.push(
        `Tarjeta ${ch.cardNumber} (${ch.name}): la suma de los consumos extraídos ($${sum.toFixed(2)}) no coincide con el subtotal impreso ($${ch.subtotalImpreso.toFixed(2)}, diferencia $${diff.toFixed(2)}) — revisar a mano contra el PDF.`,
      );
    }

    for (const c of ch.consumos) {
      let date = parseArDate(normalizeFecha(c.fecha));
      if (!date) {
        warnings.push(`Fecha no interpretada en consumo de ${ch.name}: "${c.fecha}" (${c.descripcion}) — se omite.`);
        continue;
      }
      // Un consumo no puede ser posterior al cierre del resumen: casi seguro el
      // lector se equivocó de año (pasó con "15 Dic" leído como 2026 en un
      // resumen de 2025). Se corre un año atrás y se avisa.
      if (cierreDate && date.getTime() > cierreDate.getTime() + 2 * 24 * 60 * 60 * 1000) {
        const corrected = new Date(date);
        corrected.setFullYear(corrected.getFullYear() - 1);
        if (corrected.getTime() <= cierreDate.getTime() + 2 * 24 * 60 * 60 * 1000) {
          warnings.push(
            `Consumo de ${ch.name} "${c.descripcion}": la fecha ${c.fecha} es posterior al cierre del resumen — se corrigió el año automáticamente.`,
          );
          date = corrected;
        }
      }
      rows.push({
        date,
        description: c.descripcion,
        amount: -Math.abs(c.importe),
        currency: "ARS",
        counterparty: c.descripcion,
        // Conservador: un consumo de tarjeta normal NO se categoriza solo,
        // salvo que la descripción matchee un cargo bancario conocido (ej.
        // "COMIS.RENOVAC.ANUAL" de una tarjeta adicional) — ver fee-categories.ts.
        category: detectFeeCategory(c.descripcion),
        raw: {
          cardNumber: ch.cardNumber,
          cardholder: ch.name,
          comprobante: c.comprobante,
          cuotas: c.cuotas,
          checksumOk,
          subtotalImpreso: ch.subtotalImpreso,
        },
      });
    }
  }

  // Los cargos generales no traen fecha propia: llevan la del cierre, o si esa
  // no se pudo leer, la del último consumo (nunca la de hoy, que los dejaba
  // meses fuera de la ventana de pago del resumen).
  const lastConsumoDate = rows.reduce<Date | null>((max, r) => (!max || r.date > max ? r.date : max), null);

  for (const cargo of extraction.cargosVarios ?? []) {
    rows.push({
      date: cierreDate ?? lastConsumoDate ?? new Date(),
      description: cargo.descripcion,
      amount: -Math.abs(cargo.importe),
      currency: "ARS",
      counterparty: "Banco (cargo del resumen)",
      // Los cargos generales del resumen (no atados a ninguna tarjeta) son,
      // por definición, plata que cobra el banco directo — nunca van a tener
      // una factura o transferencia con la que cruzar, así que van
      // categorizados siempre, sin necesidad de que matcheen un patrón. Si
      // la descripción sí matchea un patrón específico (impuestos/comisiones
      // vs. intereses), se usa esa categoría más precisa; si no, el genérico
      // "Gastos operativos" de fallback.
      category: detectFeeCategory(cargo.descripcion) ?? DEFAULT_FEE_CATEGORY,
      raw: { cargoDelResumen: true, descripcion: cargo.descripcion },
    });
  }

  return { rows, warnings, needsReview, reviewNotes };
}
