import type { Metadata, Viewport } from "next";
import "@fontsource-variable/inter";
import "@fontsource-variable/manrope";
import "@/styles/tokens.css";
import "@/styles/base.css";
import "@/styles/shell.css";
import "@/styles/components.css";
import { ToastProvider } from "@/components/Toast";

export const metadata: Metadata = { title: "LeadHunter", description: "Приватное рабочее пространство для поиска и квалификации компаний", robots: { index: false, follow: false } };
export const viewport: Viewport = { themeColor: "#f6f7f5", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body><ToastProvider>{children}</ToastProvider></body>
    </html>
  );
}
