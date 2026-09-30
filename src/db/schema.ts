import {
  pgTable,
  pgEnum,
  serial,
  text,
  timestamp,
  numeric,
  integer,
  jsonb,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";

// -----------------------------------------------------------------------
// Enums
// -----------------------------------------------------------------------

export const sourceEnum = pgEnum("source", [
  "bank",
  "card",
  "afip_issued",
  "afip_received",
]);

export const matchStatusEnum = pgEnum("match_status", [
  "auto",
  "confirmed",
  "rejected",
  "manual",
  "pending",
]);

export const matchStrategyEnum = pgEnum("match_strategy", [
  "exact_1to1",
  "card_statement_1toN",
  "fuzzy",
  "manual",
]);

// -----------------------------------------------------------------------
// Tables
// -----------------------------------------------------------------------

/** Un lote de importación: un archivo subido una vez (CSV banco, CSV AFIP, PDF tarjeta) */
export const importBatches = pgTable("import_batches", {
  id: serial("id").primaryKey(),
  source: sourceEnum("source").notNull(),
  filename: text("filename").notNull(),
  accountRef: text("account_ref"), // ej: "Banco Galicia CC", "Visa Santander"
  importedAt: timestamp("imported_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  rowCount: integer("row_count").notNull().default(0),
  // mapeo de columnas usado (relevante para bank-csv, para poder re-aplicarlo)
  columnMapping: jsonb("column_mapping"),
});

/** Cada movimiento normalizado, sin importar la fuente */
export const transactions = pgTable(
  "transactions",
  {
    id: serial("id").primaryKey(),
    batchId: integer("batch_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "cascade" }),
    source: sourceEnum("source").notNull(),
    date: timestamp("date", { withTimezone: false }).notNull(),
    description: text("description").notNull(),
    // positivo = ingreso, negativo = egreso (normalizado en el parser)
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("ARS"),
    accountRef: text("account_ref"),
    // CUIT o razón social de la contraparte, cuando se puede extraer
    counterparty: text("counterparty"),
    // documento original completo (fila CSV, o bloque de texto del PDF)
    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("transactions_date_idx").on(t.date),
    index("transactions_amount_idx").on(t.amount),
    index("transactions_source_idx").on(t.source),
  ],
);

/** Un grupo de conciliación: une 1 o más transacciones que representan el mismo hecho económico */
export const matches = pgTable("matches", {
  id: serial("id").primaryKey(),
  status: matchStatusEnum("status").notNull().default("pending"),
  strategy: matchStrategyEnum("strategy").notNull(),
  // 0-100, qué tan seguro está el motor del match
  confidence: integer("confidence").notNull().default(0),
  // diferencia de importe entre los lados del match, si la hay
  amountDiff: numeric("amount_diff", { precision: 14, scale: 2 })
    .notNull()
    .default("0"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

/** Relación N a N entre matches y transactions */
export const matchItems = pgTable(
  "match_items",
  {
    matchId: integer("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    transactionId: integer("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.matchId, t.transactionId] })],
);
