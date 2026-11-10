"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Модальное окно: aria-modal, фокус внутри, Esc, возврат фокуса. */
export function Modal({ title, onClose, children, labelId, describedBy }: { title: string; onClose: () => void; children: ReactNode; labelId?: string; describedBy?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const autoId = useId();
  const titleId = labelId ?? `modal-title-${autoId}`;
  // onClose часто передаётся новой стрелочной функцией: держим его в ref, чтобы эффект
  // (перенос фокуса внутрь и возврат при закрытии) выполнялся только при монтировании,
  // а не на каждом ререндере родителя (иначе фокус «прыгал» при обновлении данных).
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current!;
    const focusables = () => Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
    (el.querySelector<HTMLElement>("[data-autofocus]") ?? focusables()[0] ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); closeRef.current(); }
      if (e.key === "Tab") {
        const f = focusables();
        if (!f.length) { e.preventDefault(); el.focus(); return; }
        const first = f[0]!, last = f[f.length - 1]!;
        const inside = el.contains(document.activeElement);
        if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Возвращаем фокус на элемент-источник; если его уже нет в DOM — на основную область.
      if (prev && prev.isConnected) prev.focus();
      else document.getElementById("content")?.focus();
    };
  }, []);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={describedBy} ref={ref} tabIndex={-1}>
        <h2 id={titleId} tabIndex={-1} style={{ outline: "none" }}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, text, confirmLabel, danger, busy, onConfirm, onCancel }: {
  title: string; text: ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  const descId = useId();
  return (
    <Modal title={title} onClose={onCancel} describedBy={descId}>
      <div id={descId} style={{ color: "var(--ink-2)", lineHeight: 1.65 }}>{text}</div>
      <div className="dialog-actions">
        <button className="btn" onClick={onCancel} data-autofocus>Отмена</button>
        <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={onConfirm} disabled={busy}>{confirmLabel}</button>
      </div>
    </Modal>
  );
}
