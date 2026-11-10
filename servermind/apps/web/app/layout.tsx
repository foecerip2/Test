import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "ServerMind — AI-системный администратор VPS", template: "%s · ServerMind" },
  description: "Серверы под контролем. AI рядом.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#080f1e",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
