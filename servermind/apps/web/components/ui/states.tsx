import type { ReactNode } from "react";
import { CloudOff, Inbox, RotateCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ErrorCode } from "@/lib/types";

export function EmptyState({
  icon, title, description, action, className,
}: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center gap-3 rounded-card border border-dashed border-stroke px-6 py-12 text-center", className)}>
      <div className="grid size-12 place-items-center rounded-full bg-elevated text-text-muted [&_svg]:size-6">{icon ?? <Inbox aria-hidden />}</div>
      <h3 className="text-base font-semibold">{title}</h3>
      {description && <p className="max-w-md text-sm text-text-secondary">{description}</p>}
      {action && <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function ErrorState({
  code, message, onRetry, className, compact,
}: { code?: ErrorCode; message: string; onRetry?: () => void; className?: string; compact?: boolean }) {
  const offline = code === "backend_unavailable";
  const Icon = offline ? CloudOff : TriangleAlert;
  const title = offline ? "Сервис недоступен" : code === "unauthorized" ? "Требуется вход" : code === "forbidden" ? "Недостаточно прав" : code === "not_found" ? "Не найдено" : "Не удалось выполнить";
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center gap-3 rounded-card border border-danger/30 bg-[var(--tint-danger)] text-center",
        compact ? "px-4 py-6" : "px-6 py-12",
        className,
      )}
    >
      <Icon aria-hidden className="size-6 text-danger" />
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="max-w-md text-sm text-text-secondary">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <RotateCw /> Повторить
        </Button>
      )}
    </div>
  );
}

/** Встроенное сообщение формы / блока (не карточка). */
export function InlineAlert({
  tone = "info", title, children, className,
}: { tone?: "info" | "warning" | "danger" | "success"; title?: string; children: ReactNode; className?: string }) {
  const map = {
    info: "border-info/30 bg-[var(--tint-info)] [--c:var(--color-info)]",
    warning: "border-warning/30 bg-[var(--tint-warning)] [--c:var(--color-warning)]",
    danger: "border-danger/30 bg-[var(--tint-danger)] [--c:var(--color-danger)]",
    success: "border-success/30 bg-[var(--tint-success)] [--c:var(--color-success)]",
  } as const;
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cn("rounded-control border p-3 text-sm", map[tone], className)}>
      {title && <p className="font-medium text-[var(--c)]">{title}</p>}
      <div className="text-text-secondary">{children}</div>
    </div>
  );
}
