import { NavBar } from "@/components/nav-bar";
import { AfipImportForm } from "./afip-form";
import { BankImportForm } from "./bank-form";
import { CardImportForm } from "./card-form";
import { Card, CardHeader } from "@/components/ui";
import { IconBank, IconFileText, IconCreditCard } from "@/components/icons";

// Leer un resumen de tarjeta con Claude (y más si se suben varios PDF juntos)
// puede tardar bien más que los 10s que Vercel usa de límite por default en
// las funciones. Sin esto, la conexión se corta a mitad de camino y el
// navegador muestra "la página no pudo cargar" aunque el server siga
// procesando. 60s es el máximo permitido en el plan Hobby. (Va acá, en la
// página — un archivo "use server" solo puede exportar funciones async.)
export const maxDuration = 60;

export default function ImportPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <NavBar />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-slate-900">Importar</h1>
          <p className="text-sm text-slate-500">Subí archivos de banco, tarjeta o AFIP para conciliar</p>
        </div>

        <div className="grid gap-6 md:grid-cols-3">
          <Card>
            <CardHeader
              title="Movimientos bancarios"
              subtitle="CSV exportado del homebanking"
              action={<IconBank width={18} height={18} className="text-indigo-500" />}
            />
            <div className="p-5">
              <BankImportForm />
            </div>
          </Card>
          <Card>
            <CardHeader
              title="Facturas AFIP"
              subtitle="CSV de 'Mis Comprobantes'"
              action={<IconFileText width={18} height={18} className="text-indigo-500" />}
            />
            <div className="p-5">
              <AfipImportForm />
            </div>
          </Card>
          <Card>
            <CardHeader
              title="Resumen de tarjeta"
              subtitle="PDF del resumen"
              action={<IconCreditCard width={18} height={18} className="text-indigo-500" />}
            />
            <div className="p-5">
              <CardImportForm />
            </div>
          </Card>
        </div>
      </main>
    </div>
  );
}
