import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function SkeletonBlock({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden className={cn("sm-skeleton rounded-control", className)} {...props} />;
}

/** Обёртка загрузки: сообщает скринридеру о состоянии, визуально — набор скелетонов. */
export function LoadingRegion({ label = "Загрузка…", className, children }: { label?: string; className?: string; children: React.ReactNode }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}
