import { cn } from "@/lib/utils";

/** UsageMeter: статус не только цветом — подпись «норма / высокая / критичная». Нет данных → «нет данных». */
export function UsageMeter({
  label, value, detail, className,
}: { label: string; value: number | null; detail?: string; className?: string }) {
  const level = value == null ? "none" : value >= 90 ? "crit" : value >= 75 ? "warn" : "ok";
  const color = level === "crit" ? "bg-danger" : level === "warn" ? "bg-warning" : "bg-primary";
  const text = level === "crit" ? "критично" : level === "warn" ? "высокая" : level === "ok" ? "норма" : "нет данных";
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex flex-col gap-0.5">
        <span className="label whitespace-nowrap text-text-secondary">{label}</span>
        <span className="tabular whitespace-nowrap text-sm font-medium">
          {value == null ? "—" : `${Math.round(value)}%`}
          <span className="ml-1.5 text-xs font-normal text-text-muted">{text}</span>
        </span>
      </div>
      <div
        role={value == null ? "img" : "meter"}
        aria-label={value == null ? `${label}: нет данных` : label}
        {...(value == null ? {} : { "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": value })}
        aria-valuetext={value == null ? undefined : `${Math.round(value)}% — ${text}`}
        className="h-1.5 overflow-hidden rounded-full bg-elevated"
      >
        <div
          className={cn("h-full rounded-full transition-[width] duration-300 ease-out", color)}
          style={{ width: `${Math.min(100, Math.max(0, value ?? 0))}%` }}
        />
      </div>
      {detail && <p className="tabular text-xs text-text-muted">{detail}</p>}
    </div>
  );
}

/** Прогресс выполнения. Значение — только из событий бэкенда (done/total), без случайных приращений. */
export function ProgressBar({ done, total, label, tone = "primary" }: { done: number; total: number; label: string; tone?: "primary" | "danger" | "success" }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const color = tone === "danger" ? "bg-danger" : tone === "success" ? "bg-success" : "bg-primary";
  return (
    <div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-valuetext={`Выполнено ${done} из ${total}`}
        className="h-2 overflow-hidden rounded-full bg-elevated"
      >
        <div className={cn("h-full rounded-full transition-[width] duration-300 ease-out", color)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
