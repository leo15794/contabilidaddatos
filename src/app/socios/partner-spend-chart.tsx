"use client";

import { useState } from "react";

const fmt = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });

const MES_LABELS: Record<string, string> = {
  "01": "Ene", "02": "Feb", "03": "Mar", "04": "Abr", "05": "May", "06": "Jun",
  "07": "Jul", "08": "Ago", "09": "Sep", "10": "Oct", "11": "Nov", "12": "Dic",
};

function monthLabel(key: string) {
  const [, m] = key.split("-");
  return MES_LABELS[m] ?? m;
}

/** Barras de gasto mensual de un socio, con tooltip al pasar el mouse. Una sola serie -> un solo color (violeta, el mismo que usa "Gastos operativos"/socios en el resto de la app), sin necesidad de leyenda. */
export function PartnerSpendChart({ data }: { data: { month: string; total: number }[] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.total));

  return (
    <div className="px-5 py-4">
      <div className="flex items-end gap-3" style={{ height: 140 }}>
        {data.map((d, i) => {
          const heightPct = (d.total / max) * 100;
          const isHovered = hovered === i;
          return (
            <div
              key={d.month}
              className="relative flex flex-1 flex-col items-center justify-end gap-2"
              style={{ height: "100%" }}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
            >
              {isHovered && (
                <div className="absolute -top-9 z-10 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[11px] font-medium text-white shadow-sm">
                  {fmt.format(d.total)}
                </div>
              )}
              <div className="flex w-full flex-1 items-end">
                <div
                  className={`w-full rounded-t-[4px] transition-colors ${
                    isHovered ? "bg-violet-600" : "bg-violet-400"
                  }`}
                  style={{ height: `${Math.max(heightPct, d.total > 0 ? 3 : 0)}%` }}
                />
              </div>
              <span className="text-[11px] text-slate-400">{monthLabel(d.month)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
