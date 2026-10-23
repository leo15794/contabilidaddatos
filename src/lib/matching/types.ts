import type { transactions } from "@/db/schema";

export type Txn = typeof transactions.$inferSelect;

/** Un match calculado en memoria; se persiste todo junto al final de la corrida (ver `persistMatches` en engine.ts). */
export type MatchSpec = {
  strategy: "exact_1to1" | "card_statement_1toN" | "cuit_group" | "fuzzy";
  status: "auto" | "pending";
  confidence: number;
  amountDiff: number;
  transactionIds: number[];
  note?: string;
};

export type StepResult = { specs: MatchSpec[]; remaining: Txn[] };

// Pares de movimientos que ya se rechazaron a mano. Un match rechazado libera
// a sus movimientos, y sin esto el motor volvía a proponer el mismo par idéntico
// en la corrida siguiente. Un match de varios movimientos aporta todos sus pares.
export type RejectedPairs = Set<string>;
export const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
