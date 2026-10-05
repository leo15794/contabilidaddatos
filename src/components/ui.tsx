import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-[20px] border border-slate-100 bg-white shadow-[0_1px_2px_rgba(15,23,42,.04),0_10px_28px_-16px_rgba(15,23,42,.14)] transition-shadow duration-200 hover:shadow-[0_1px_2px_rgba(15,23,42,.04),0_14px_32px_-14px_rgba(15,23,42,.18)] ${className}`}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-slate-100 px-6 py-4.5">
      <div>
        <h2 className="text-[13.5px] font-bold text-slate-900">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success";
type ButtonSize = "sm" | "md";

export function Button({
  children,
  variant = "primary",
  size = "md",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-xl font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2";
  const sizes: Record<ButtonSize, string> = {
    sm: "px-3 py-1.5 text-xs",
    md: "px-4.5 py-2.5 text-sm",
  };
  const variants: Record<ButtonVariant, string> = {
    primary:
      "bg-indigo-600 text-white shadow-[0_8px_20px_-8px_rgba(79,70,229,.55)] hover:bg-indigo-700 focus-visible:ring-indigo-500",
    secondary: "bg-slate-100 text-slate-700 hover:bg-slate-200 focus-visible:ring-slate-400",
    ghost: "text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:ring-slate-400",
    danger: "bg-rose-50 text-rose-700 hover:bg-rose-100 focus-visible:ring-rose-400",
    success:
      "bg-emerald-600 text-white shadow-[0_8px_20px_-8px_rgba(5,150,105,.5)] hover:bg-emerald-700 focus-visible:ring-emerald-500",
  };

  return (
    <button className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} {...props}>
      {children}
    </button>
  );
}

export const SOURCE_STYLES: Record<string, { label: string; dot: string }> = {
  bank: { label: "Banco", dot: "bg-blue-500" },
  card: { label: "Tarjeta", dot: "bg-violet-500" },
  afip_issued: { label: "AFIP emitidas", dot: "bg-cyan-500" },
  afip_received: { label: "AFIP recibidas", dot: "bg-teal-500" },
  ticket: { label: "Ticket (WhatsApp)", dot: "bg-green-500" },
};

export function SourceBadge({ source }: { source: string }) {
  const s = SOURCE_STYLES[source] ?? { label: source, dot: "bg-slate-400" };
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-slate-600">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

export function Amount({ value, className = "" }: { value: number; className?: string }) {
  const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });
  const tone = value < 0 ? "text-rose-600" : "text-emerald-600";
  return <span className={`tabular-nums font-medium ${tone} ${className}`}>{fmt.format(value)}</span>;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div className="mb-1 flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-400">
        {icon}
      </div>
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {description && <p className="max-w-xs text-xs text-slate-500">{description}</p>}
      {action}
    </div>
  );
}
