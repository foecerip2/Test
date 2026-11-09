"use client";

import * as S from "@radix-ui/react-switch";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

/** Переключатель. Hit-area ≥ 44px обеспечена обёрткой-лейблом на месте использования (см. SettingRow). */
export function Switch({ className, ...props }: ComponentPropsWithoutRef<typeof S.Root>) {
  return (
    <S.Root
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full border border-stroke bg-elevated transition-colors duration-120 data-[state=checked]:border-primary data-[state=checked]:bg-primary disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <S.Thumb className="block size-[18px] translate-x-[2px] rounded-full bg-text transition-transform duration-120 data-[state=checked]:translate-x-[22px] data-[state=checked]:bg-canvas" />
    </S.Root>
  );
}
