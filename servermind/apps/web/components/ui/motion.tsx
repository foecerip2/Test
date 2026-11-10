"use client";

import { AnimatePresence, LazyMotion, MotionConfig, domAnimation, m } from "motion/react";
import type { ReactNode } from "react";

/**
 * Motion подключается лениво (LazyMotion + domAnimation, `m.*`) — минимальный вклад в бандл.
 * reducedMotion="user": при prefers-reduced-motion transform-анимации отключаются.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user" transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
        {children}
      </MotionConfig>
    </LazyMotion>
  );
}

export { AnimatePresence, m };

/** Появление блока: opacity + 8px. Без stagger по всей странице (§16.4). */
export function FadeIn({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <m.div className={className} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
      {children}
    </m.div>
  );
}
