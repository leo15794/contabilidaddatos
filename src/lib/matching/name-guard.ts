import { extractCuits } from "./cuit";
import { OWN_CUITS } from "./exclusions";
import { tokenize } from "./text-similarity";
import type { Txn } from "./types";

/**
 * Un pago del banco cuya descripción NOMBRA a un comercio ("GOOGLE ARGENTINA SRL")
 * no puede cruzar con la factura de OTRO proveedor solo porque el importe es el
 * mismo: el motor unía un pago de Google de $300.000 con una factura de Saucedo de
 * $300.000. Las descripciones genéricas de transferencia ("Transf. MacrOnline",
 * "DB TRANSF MINORISTA", "TRF MO CCDO ...") no nombran a nadie y siguen cruzando
 * por importe y fecha.
 */
const GENERIC = new Set([
  "transf", "transferencia", "trf", "macronline", "minorista", "tef", "datanet", "debito", "credito", "cuenta",
  "liq", "plazo", "imp", "comision", "operacion", "numero", "retiro", "pago", "servicio", "visa", "pesos", "mismo",
  "dist", "tit", "caj", "var", "egreso", "ccdo", "set", "pyme", "extrac", "efvo", "gral", "dbcr", "tasa", "iva",
  "srl", "sociedad", "anonima", "limitada",
]);

// Solo se desconfía de nombres de empresa (SRL, S.A.): un "TRANSF FRANCISCO ..." nombra a una persona
// y puede pagar a su empresa con otro nombre.
const COMPANY_SUFFIX = /\b(srl|s\.r\.l\.?|s\.a\.?|sa|sas|s\.a\.s\.?)(?=\s|$)/i;

function bankNameWords(bank: Txn): string[] {
  return [...tokenize(bank.description)].filter((w) => w.length >= 4 && !/^\d+$/.test(w) && !GENERIC.has(w));
}

function supplierWords(doc: Txn): Set<string> {
  const name = (doc.counterparty ?? "").replace(/^[\d.\s-]+/, "");
  return tokenize(name);
}

/** true si el pago nombra a un comercio y la factura es de otro (sin CUIT ni palabras en común). */
export function bankNamesAnotherParty(bank: Txn, doc: Txn): boolean {
  if (bank.source !== "bank") return false;
  if (!COMPANY_SUFFIX.test(bank.description)) return false;
  const words = bankNameWords(bank);
  if (words.length === 0) return false; // descripción genérica: no nombra a nadie

  const bankCuits = extractCuits(`${bank.description} ${bank.counterparty ?? ""}`).filter((c) => !OWN_CUITS.includes(c));
  const docCuit = extractCuits(doc.counterparty)[0];
  if (docCuit && bankCuits.includes(docCuit)) return false;

  const docWords = supplierWords(doc);
  return !words.some((w) => docWords.has(w));
}
