import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getSessionInfo } from "@/lib/auth/session";
import { NavBarClient } from "./nav-bar-client";

/**
 * Barra lateral. Se arma en el servidor porque necesita saber quién entró
 * (nombre y rol) y los contadores de pendientes que se muestran al lado de
 * "Revisar sugerencias" y "Sin conciliar".
 */
export async function NavBar() {
  const me = await getSessionInfo();
  const readOnly = me?.role === "contador";

  const [counts] = await db.execute<{ pending: number; unmatched: number }>(sql`
    select
      (select count(*) from matches where status = 'pending')::int as pending,
      (select count(*) from transactions t
        where (t.category is null or t.category = '')
          and not exists (select 1 from match_items mi join matches m on m.id = mi.match_id
                          where mi.transaction_id = t.id and m.status <> 'rejected'))::int as unmatched
  `);

  return (
    <NavBarClient
      readOnly={readOnly}
      user={{
        name: me?.name ?? "Usuario",
        roleLabel: readOnly ? "Solo lectura" : "Administrador",
      }}
      counts={{ pending: Number(counts?.pending ?? 0), unmatched: Number(counts?.unmatched ?? 0) }}
    />
  );
}
