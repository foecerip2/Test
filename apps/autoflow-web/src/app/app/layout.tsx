import type { ReactNode } from "react";
export const metadata = {
  title: "Рабочее пространство — AutoFlow",
  robots: { index: false, follow: false },
};
export default function AppLayout({ children }: { children: ReactNode }) {
  return children;
}
