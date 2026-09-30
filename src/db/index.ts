import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "Falta la variable de entorno DATABASE_URL. Configurala en .env.local (desarrollo) o en Vercel (producción).",
  );
}

// En serverless (Vercel) conviene una sola conexión reutilizada y sin pool grande.
const client = postgres(connectionString, { max: 1, prepare: false });

export const db = drizzle(client, { schema });
export * from "./schema";
