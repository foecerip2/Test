"use client";

import * as C from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Чекбокс с подписью; вся строка — область нажатия ≥ 44px. */
export function CheckboxField({
  label, className, ...props
}: ComponentPropsWithoutRef<typeof C.Root> & { label: ReactNode }) {
  return (
    <label className={cn("flex min-h-11 cursor-pointer items-start gap-3 rounded-control py-2 text-sm", className)}>
      <C.Root
        className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-[6px] border border-stroke bg-canvas transition-colors data-[state=checked]:border-primary data-[state=checked]:bg-primary disabled:cursor-not-allowed disabled:opacity-50"
        {...props}
      >
        <C.Indicator><Check className="size-3.5 text-canvas" strokeWidth={3} /></C.Indicator>
      </C.Root>
      <span className="text-text-secondary">{label}</span>
    </label>
  );
}
