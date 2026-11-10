import type { ReactNode } from "react";

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-stroke bg-elevated px-1 font-mono text-[11px] text-text-secondary">
      {children}
    </kbd>
  );
}

/** KeyboardShortcutHint: скрыт на устройствах без физической клавиатуры (touch). */
export function KeyboardShortcutHint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="hidden items-center gap-1.5 text-xs text-text-muted [@media(hover:hover)]:inline-flex">
      {keys.map((k) => <Kbd key={k}>{k}</Kbd>)}
      <span>{label}</span>
    </span>
  );
}
