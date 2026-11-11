import type { ReactNode } from "react";

type P = { size?: number };
const base = (size: number, children: ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {children}
  </svg>
);

export const IconLink = ({ size = 24 }: P) => base(size, <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>);
export const IconCalendar = ({ size = 24 }: P) => base(size, <><rect x="3.5" y="5" width="17" height="15.5" rx="3" /><path d="M8 3v4M16 3v4M3.5 10h17" /><path d="m9 15 2 2 4-4" /></>);
export const IconBell = ({ size = 24 }: P) => base(size, <><path d="M6 17V11a6 6 0 1 1 12 0v6l1.5 2h-15z" /><path d="M10 21h4" /></>);
export const IconPhone = ({ size = 24 }: P) => base(size, <><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M11 18.5h2" /></>);
export const IconCheck = ({ size = 24 }: P) => base(size, <path d="m5 12.5 4.5 4.5L19 7.5" />);
export const IconPlus = ({ size = 24 }: P) => base(size, <path d="M12 5v14M5 12h14" />);
export const IconMinus = ({ size = 24 }: P) => base(size, <path d="M5 12h14" />);
export const IconInfo = ({ size = 24 }: P) => base(size, <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>);
export const IconAlert = ({ size = 24 }: P) => base(size, <><path d="M12 3.5 2.5 20h19z" /><path d="M12 10v4.5M12 17.5h.01" /></>);

/** Знак AutoFlow: слоты расписания и галочка подтверждения. Тот же рисунок — в icon.svg и в Android-иконке. */
export function LogoMark() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <rect width="64" height="64" rx="16" fill="#C2410C" />
      <rect x="14" y="15" width="24" height="7" rx="3.5" fill="#fff" />
      <rect x="14" y="27" width="36" height="7" rx="3.5" fill="#fff" fillOpacity=".6" />
      <path d="M15 47.5l6.5 6.5L36 40.5" fill="none" stroke="#fff" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
