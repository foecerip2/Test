"use client";
import { useEffect, useState } from "react";
import { formatCountdown, remainingSeconds } from "@/lib/auth";
import s from "./auth.module.css";

const R = 9;
const C = 2 * Math.PI * R;

/** Повторная отправка: обратный отсчёт с кольцевым индикатором, затем активная кнопка. */
export function ResendTimer({ seconds, restartKey, onResend, busy, label = "Отправить код ещё раз", primary }: {
  /** Длительность ожидания, с. */
  seconds: number;
  /** Меняется при каждой новой отправке — отсчёт запускается заново. */
  restartKey: number;
  onResend: () => void;
  busy?: boolean;
  label?: string;
  primary?: boolean;
}) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    const deadline = Date.now() + seconds * 1000;
    setLeft(seconds);
    const id = setInterval(() => {
      const r = remainingSeconds(deadline, Date.now());
      setLeft(r);
      if (r <= 0) clearInterval(id);
    }, 250);
    return () => clearInterval(id);
  }, [seconds, restartKey]);

  if (left > 0) {
    const progress = Math.min(1, left / Math.max(1, seconds));
    return (
      <div className={s.resend} data-waiting="">
        <svg className={s.ring} viewBox="0 0 24 24" aria-hidden="true">
          <circle className={s.ringBg} cx="12" cy="12" r={R} />
          <circle className={s.ringFg} cx="12" cy="12" r={R} strokeDasharray={C} strokeDashoffset={C * (1 - progress)} />
        </svg>
        <span>Отправить код ещё раз через <span className={s.time}>{formatCountdown(left)}</span></span>
      </div>
    );
  }
  return (
    <div className={s.resend}>
      <button type="button" className={primary ? "btn btn-primary" : "btn btn-quiet"} style={primary ? { width: "100%" } : undefined} onClick={onResend} disabled={busy}>
        {busy ? "Отправляем…" : label}
      </button>
    </div>
  );
}
