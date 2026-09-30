import { NavBar } from "@/components/nav-bar";
import { AfipImportForm } from "./afip-form";
import { BankImportForm } from "./bank-form";
import { CardImportForm } from "./card-form";

export default function ImportPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <NavBar />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <h1 className="mb-6 text-lg font-semibold text-slate-900">Importar</h1>

        <div className="grid gap-6 md:grid-cols-3">
          <Card title="Movimientos bancarios" subtitle="CSV exportado del homebanking">
            <BankImportForm />
          </Card>
          <Card title="Facturas AFIP" subtitle="CSV de 'Mis Comprobantes'">
            <AfipImportForm />
          </Card>
          <Card title="Resumen de tarjeta" subtitle="PDF del resumen">
            <CardImportForm />
          </Card>
        </div>
      </main>
    </div>
  );
}

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-medium text-slate-900">{title}</h2>
      <p className="mb-4 text-xs text-slate-500">{subtitle}</p>
      {children}
    </div>
  );
}
