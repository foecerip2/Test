"use client";
import { useEffect, useRef, type ReactNode } from "react";

/** Модальное окно: aria-modal, фокус внутри, Esc, возврат фокуса. */
export function Modal({ title, onClose, children, labelId = "modal-title" }: { title: string; onClose: () => void; children: ReactNode; labelId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current!;
    const focusables = () => Array.from(el.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'));
    (el.querySelector<HTMLElement>("[data-autofocus]") ?? focusables()[0] ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      if (e.key === "Tab") {
        const f = focusables();
        if (!f.length) return;
        const first = f[0]!, last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); prev?.focus?.(); };
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={labelId} ref={ref} tabIndex={-1}>
        <h2 id={labelId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, text, confirmLabel, danger, busy, onConfirm, onCancel }: {
  title: string; text: ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <div style={{ color: "var(--ink-2)", lineHeight: 1.65 }}>{text}</div>
      <div className="dialog-actions">
        <button className="btn" onClick={onCancel} data-autofocus>Отмена</button>
        <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={onConfirm} disabled={busy}>{confirmLabel}</button>
      </div>
    </Modal>
  );
}
