"use client";

import * as T from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

export const TooltipProvider = T.Provider;

/** Подсказка (120 мс fade). Для критичной информации не используется — только пояснения. */
export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <T.Root delayDuration={200}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          sideOffset={6}
          className="z-[80] max-w-[260px] rounded-control border border-stroke bg-elevated px-3 py-2 text-xs leading-[18px] text-text shadow-[var(--shadow-overlay)] data-[state=delayed-open]:animate-[sm-fade-in_120ms_ease-out]"
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
