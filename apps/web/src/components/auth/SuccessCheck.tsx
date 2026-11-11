"use client";
import s from "./auth.module.css";

/**
 * Итог успешного входа: круг, галочка (stroke-dashoffset), одна мягкая пульсация и подпись.
 * Каждый слой — CSS-анимация со стартовым состоянием в keyframes: при prefers-reduced-motion
 * анимации отключаются и сразу виден итог (круг с галочкой).
 */
export function SuccessCheck({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className={s.overlay} data-success-overlay="">
      <span className={s.badge} data-badge="">
        <svg className={s.badgeSvg} viewBox="0 0 80 80" aria-hidden="true">
          <circle className={s.disc} cx="40" cy="40" r="38" />
          <path className={s.tick} d="M24 41.5 35.5 53 57 28" pathLength={1} />
        </svg>
      </span>
      <div className={s.successText} aria-hidden="true">
        <div className={s.successTitle}>{title}</div>
        {subtitle && <div className={s.successSub}>{subtitle}</div>}
      </div>
    </div>
  );
}
