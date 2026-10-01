import { ImportActionState } from "./actions";

export function ImportFeedback({ state }: { state: ImportActionState }) {
  if (!state.error && !state.success) return null;

  return (
    <div className="space-y-1.5 rounded-lg bg-slate-50 p-2.5">
      {state.success && <p className="whitespace-pre-line text-xs font-medium text-emerald-700">{state.success}</p>}
      {state.error && <p className="whitespace-pre-line text-xs font-medium text-rose-600">{state.error}</p>}
      {state.warnings && state.warnings.length > 0 && (
        <details className="text-xs text-amber-700">
          <summary className="cursor-pointer font-medium">{state.warnings.length} avisos</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {state.warnings.slice(0, 20).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
