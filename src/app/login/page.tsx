import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const { from } = await searchParams;

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="mb-1 text-xl font-semibold text-slate-900">
          2 Datos y Mercadeo
        </h1>
        <p className="mb-6 text-sm text-slate-500">Conciliación contable</p>
        <LoginForm from={from ?? "/dashboard"} />
      </div>
    </div>
  );
}
