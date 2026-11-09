import type { HTMLAttributes, ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const badgeVariants = cva(
  "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium leading-[18px] [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        neutral: "border-stroke bg-elevated text-text-secondary",
        primary: "border-primary/30 bg-[var(--tint-primary)] text-primary",
        success: "border-success/30 bg-[var(--tint-success)] text-success",
        warning: "border-warning/30 bg-[var(--tint-warning)] text-warning",
        danger: "border-danger/30 bg-[var(--tint-danger)] text-danger",
        info: "border-info/30 bg-[var(--tint-info)] text-info",
        ai: "border-ai/30 bg-[var(--tint-ai)] text-ai",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  icon?: ReactNode;
}

export function Badge({ className, tone, icon, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}
