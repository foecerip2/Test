"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Модальное окно: aria-modal, фокус внутри, Esc, возврат фокуса. */
export function Modal({ title, onClose, children, labelId, describedBy, variant = "dialog", hideTitle, dialogClass, titleClass, dismissOnBackdrop = true, phase }: {
  title: string; onClose: () => void; children: ReactNode; labelId?: string; describedBy?: string;
  /** "sheet" — на телефоне нижний лист (bottom sheet), на широком экране обычная карточка. */
  variant?: "dialog" | "sheet";
  hideTitle?: boolean; dialogClass?: string; titleClass?: string;
  dismissOnBackdrop?: boolean;
  /** Произвольное состояние для стилей: data-phase на окне. */
  phase?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
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
  // Экранная клавиатура: лист поднимается над ней (visualViewport), чтобы поля и кнопки не перекрывались.
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    const el = backdropRef.current;
    if (variant !== "sheet" || !vv || !el) return;
    const update = () => {
      const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      el.style.setProperty("--kb", `${inset}px`);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => { vv.removeEventListener("resize", update); vv.removeEventListener("scroll", update); };
  }, [variant]);
  const vAttr = variant === "sheet" ? "sheet" : undefined;
  return (
    <div className="dialog-backdrop" data-variant={vAttr} data-phase={phase} ref={backdropRef} onMouseDown={(e) => { if (dismissOnBackdrop && e.target === e.currentTarget) onClose(); }}>
      <div className={`dialog ${dialogClass ?? ""}`} data-variant={vAttr} data-phase={phase} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={describedBy} ref={ref} tabIndex={-1}>
        <h2 id={titleId} tabIndex={-1} className={`${hideTitle ? "sr-only" : ""} ${titleClass ?? ""}`} style={{ outline: "none" }}>{title}</h2>
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
