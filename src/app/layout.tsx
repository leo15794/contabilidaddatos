import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Conciliación — 2 Datos y Mercadeo",
  description: "Conciliación automática de ingresos y egresos",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-slate-50">{children}</body>
    </html>
  );
}
