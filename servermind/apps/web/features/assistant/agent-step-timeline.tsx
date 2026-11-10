"use client";

import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import type { ToolCall } from "@/lib/types";
import { m } from "@/components/ui/motion";
import { cn } from "@/lib/utils";

/**
 * Таймлайн вызовов инструментов (только read-only). Элементы появляются последовательно (stagger ≤ 40 мс, максимум 5),
 * статус передаётся иконкой и текстом для скринридеров.
 */
export function AgentStepTimeline({ tools }: { tools: ToolCall[] }) {
  if (tools.length === 0) return null;
  return (
    <details open className="group rounded-control border border-stroke bg-canvas/60">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 text-xs font-medium text-text-secondary">
        <span>Прочитано с сервера · {tools.length}</span>
        <span className="text-text-muted group-open:hidden">показать</span>
        <span className="hidden text-text-muted group-open:inline">скрыть</span>
      </summary>
      <ol className="space-y-2 border-t border-stroke px-3 py-3">
        {tools.map((t, i) => {
          const Icon = t.status === "done" ? CheckCircle2 : t.status === "running" ? Loader2 : XCircle;
          return (
            <m.li
              key={t.id}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i, 4) * 0.04, duration: 0.18 }}
              className="flex gap-2.5 text-xs"
            >
              <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", t.status === "done" && "text-success", t.status === "running" && "sm-spin text-info", t.status === "error" && "text-danger")} />
              <div className="min-w-0">
                <p className="font-mono text-text">{t.tool} <span className="text-text-muted">{t.args}</span></p>
                <p className="text-text-secondary">{t.summary}</p>
                <span className="sr-only">{t.status === "done" ? "выполнено" : t.status === "running" ? "выполняется" : "ошибка"}</span>
              </div>
            </m.li>
          );
        })}
      </ol>
    </details>
  );
}
