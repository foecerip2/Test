"use client";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

type ToastKind = "info" | "error";
interface Item { id: number; text: string; kind: ToastKind }
const Ctx = createContext<(text: string, kind?: ToastKind) => void>(() => {});

export function useToast() { return useContext(Ctx); }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const n = useRef(0);
  const push = useCallback((text: string, kind: ToastKind = "info") => {
    const id = ++n.current;
    setItems((s) => [...s.slice(-2), { id, text, kind }]);
    setTimeout(() => setItems((s) => s.filter((x) => x.id !== id)), kind === "error" ? 6000 : 3500);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {items.map((t) => (<div key={t.id} className={`toast ${t.kind === "error" ? "error" : ""}`}>{t.text}</div>))}
      </div>
    </Ctx.Provider>
  );
}
