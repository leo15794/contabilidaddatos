import { isReadOnly } from "@/lib/auth/session";
import { NavBarClient } from "./nav-bar-client";

/** El menú necesita saber si la sesión es de solo lectura (contador), y eso se lee de la cookie en el servidor. */
export async function NavBar() {
  return <NavBarClient readOnly={await isReadOnly()} />;
}
