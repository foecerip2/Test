"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, LazyMotion, domAnimation, m } from "motion/react";
import { CheckCircle2, Info, TriangleAlert, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

type Tone = "success" | "error" | "info" | "warning";
interface ToastItem { id: number; title: string; description?: string; tone: Tone }
interface ToastApi { push: (t: Omit<ToastItem, "id">) => void }

const Ctx = createContext<ToastApi>({ push: () => undefined });
export const useToast = () => useContext(Ctx);

const ICONS = { success: CheckCircle2, error: XCircle, info: Info, warning: TriangleAlert } as const;
const COLORS: Record<Tone, string> = {
  success: "text-success",
  error: "text-danger",
  info: "text-info",
  warning: "text-warning",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((x) => x.id !== id)), []);
  const push = useCallback((t: Omit<ToastItem, "id">) => {
    const id = Date.now() + Math.random();
    setItems((l) => [...l.slice(-3), { ...t, id }]);
    setTimeout(() => dismiss(id), t.tone === "error" ? 8000 : 5000);
  }, [dismiss]);
  const value = useMemo(() => ({ push }), [push]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <LazyMotion features={domAnimation}>
        <div
          role="region"
          aria-label="Уведомления"
          aria-live="polite"
          className="pointer-events-none fixed inset-x-0 bottom-[calc(76px+env(safe-area-inset-bottom))] z-[70] flex flex-col items-center gap-2 px-4 md:inset-x-auto md:bottom-6 md:right-6 md:items-end md:px-0 lg:bottom-6"
        >
          <AnimatePresence initial={false}>
            {items.map((t) => {
              const Icon = ICONS[t.tone];
              return (
                <m.div
                  key={t.id}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 4 }}
                  transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                  className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-card border border-stroke bg-elevated p-3 shadow-[var(--shadow-overlay)]"
                >
                  <Icon aria-hidden className={cn("mt-0.5 size-5 shrink-0", COLORS[t.tone])} />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{t.title}</p>
                    {t.description && <p className="text-text-secondary">{t.description}</p>}
                  </div>
                  <button
                    type="button"
                    aria-label="Закрыть уведомление"
                    onClick={() => dismiss(t.id)}
                    className="-m-2 grid size-11 place-items-center rounded-control text-text-muted hover:text-text"
                  >
                    <X className="size-4" />
                  </button>
                </m.div>
              );
            })}
          </AnimatePresence>
        </div>
      </LazyMotion>
    </Ctx.Provider>
  );
}
