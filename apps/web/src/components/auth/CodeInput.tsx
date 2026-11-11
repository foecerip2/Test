"use client";
import { useImperativeHandle, useRef, type ClipboardEvent, type CSSProperties, type FocusEvent, type KeyboardEvent, type Ref } from "react";
import { cellsToCode, backspaceAt, isComplete, typeAt, type CellsUpdate } from "@/lib/otp";
import { OTP_LENGTH } from "@/lib/auth";
import s from "./auth.module.css";

export interface CodeInputHandle { focus(index?: number): void; element(): HTMLDivElement | null }

interface Props {
  cells: string[];
  onChange: (cells: string[]) => void;
  /** Вызывается, когда заполнены все ячейки (автоотправка). */
  onComplete: (code: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  busy?: boolean;
  /** Ячейки «собираются» к центру (анимация успеха). */
  collapse?: boolean;
  describedBy?: string;
  ref?: Ref<CodeInputHandle>;
}

/** Шесть отдельных ячеек для одноразового кода: автопереход, Backspace, стрелки, вставка и автозаполнение. */
export function CodeInput({ cells, onChange, onComplete, disabled, invalid, busy, collapse, describedBy, ref }: Props) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const group = useRef<HTMLDivElement>(null);
  // Программный перенос фокуса (автопереход) не должен срабатывать как «клик по пустой ячейке».
  const programmatic = useRef(false);
  const focusCell = (i: number) => {
    programmatic.current = true;
    refs.current[Math.max(0, Math.min(i, OTP_LENGTH - 1))]?.focus();
    programmatic.current = false;
  };
  useImperativeHandle(ref, () => ({ focus: (i = 0) => focusCell(i), element: () => group.current }));

  const apply = (u: CellsUpdate) => {
    onChange(u.cells);
    if (isComplete(u.cells)) onComplete(cellsToCode(u.cells));
    else focusCell(u.focus);
  };

  const onKeyDown = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case "Backspace": e.preventDefault(); apply(backspaceAt(cells, i)); break;
      case "Delete": { e.preventDefault(); const next = cells.slice(); next[i] = ""; onChange(next); break; }
      case "ArrowLeft": e.preventDefault(); focusCell(i - 1); break;
      case "ArrowRight": e.preventDefault(); focusCell(i + 1); break;
      case "Home": e.preventDefault(); focusCell(0); break;
      case "End": e.preventDefault(); focusCell(OTP_LENGTH - 1); break;
    }
  };
  const onPaste = (i: number, e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    apply(typeAt(cells, i, e.clipboardData.getData("text")));
  };
  const onFocus = (i: number, e: FocusEvent<HTMLInputElement>) => {
    // Пустую ячейку «через одну» не оставляем: фокус уходит на первую свободную.
    const firstEmpty = cells.findIndex((c) => !c);
    if (!programmatic.current && !cells[i] && firstEmpty >= 0 && firstEmpty < i) { focusCell(firstEmpty); return; }
    e.currentTarget.select();
  };

  return (
    <div ref={group} className={s.cells} role="group" aria-label="Код подтверждения, 6 цифр" aria-describedby={describedBy}
      data-invalid={invalid ? "" : undefined} data-busy={busy ? "" : undefined} data-collapse={collapse ? "" : undefined}>
      {cells.map((c, i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el; }}
          className={s.cell}
          style={{ "--i": i } as CSSProperties}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          enterKeyHint="done"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label={`Цифра ${i + 1} из ${OTP_LENGTH}`}
          aria-invalid={invalid || undefined}
          data-filled={c ? "true" : "false"}
          data-autofocus={i === 0 ? "" : undefined}
          value={c}
          disabled={disabled}
          onChange={(e) => apply(typeAt(cells, i, e.target.value))}
          onKeyDown={(e) => onKeyDown(i, e)}
          onPaste={(e) => onPaste(i, e)}
          onFocus={(e) => onFocus(i, e)}
        />
      ))}
    </div>
  );
}
