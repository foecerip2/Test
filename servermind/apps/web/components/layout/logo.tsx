import { cn } from "@/lib/utils";

/** Знак: три смещённых слоя (стек серверов). Оригинальная SVG-графика проекта. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("size-7", className)} fill="none">
      <path d="M16 3.5 28 10l-12 6.5L4 10 16 3.5Z" fill="var(--color-primary)" />
      <path d="m4 15.2 12 6.5 12-6.5" stroke="var(--color-primary)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" opacity="0.75" />
      <path d="m4 20.6 12 6.5 12-6.5" stroke="var(--color-primary)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" opacity="0.45" />
    </svg>
  );
}

export function Logo({ className, size = "md" }: { className?: string; size?: "md" | "lg" }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <LogoMark className={size === "lg" ? "size-9" : "size-7"} />
      <span className={cn("font-semibold tracking-tight", size === "lg" ? "text-2xl" : "text-lg")}>
        Server<span className="text-primary">Mind</span>
      </span>
    </span>
  );
}
