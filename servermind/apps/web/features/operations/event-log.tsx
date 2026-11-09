import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { JobEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

const pad = (n: number) => String(n).padStart(2, "0");
const time = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};

/** Журнал событий. Append-only на уровне UI; секреты редактируются на сервере до отправки сюда. */
export function EventLog({ events, className }: { events: JobEvent[]; className?: string }) {
  if (events.length === 0) return <p className="text-sm text-text-muted">Событий пока нет.</p>;
  return (
    <ol role="log" aria-label="Журнал выполнения" className={cn("space-y-1 rounded-control border border-stroke bg-canvas p-3 font-mono text-xs leading-5", className)}>
      {events.map((e) => {
        const Icon = e.level === "error" ? CircleAlert : e.level === "warn" ? TriangleAlert : /успеш/.test(e.message) ? CircleCheck : Info;
        const color = e.level === "error" ? "text-danger" : e.level === "warn" ? "text-warning" : "text-text-secondary";
        return (
          <li key={e.id} className="flex gap-2">
            <time dateTime={e.at} className="tabular shrink-0 text-text-muted">{time(e.at)}</time>
            <Icon aria-hidden className={cn("mt-0.5 size-3.5 shrink-0", color)} />
            <span className="sr-only">{e.level === "error" ? "Ошибка: " : e.level === "warn" ? "Предупреждение: " : ""}</span>
            <span className={cn("min-w-0 break-words", color)}>{e.message}</span>
          </li>
        );
      })}
    </ol>
  );
}
