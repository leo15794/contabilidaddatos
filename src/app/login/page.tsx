import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const { from } = await searchParams;

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-slate-50 px-4">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(79,70,229,0.12),transparent_45%),radial-gradient(circle_at_80%_0%,rgba(79,70,229,0.08),transparent_40%)]" />
      <div className="relative w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-xl shadow-slate-200/60">
        <span className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-600 text-base font-bold text-white shadow-sm">
          2D
        </span>
        <h1 className="mb-1 text-xl font-semibold text-slate-900">2 Datos y Mercadeo</h1>
        <p className="mb-6 text-sm text-slate-500">Conciliación contable</p>
        <LoginForm from={from ?? "/dashboard"} />
      </div>
    </div>
  );
}
