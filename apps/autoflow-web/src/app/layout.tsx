import type { Metadata, Viewport } from "next";
import "@fontsource-variable/onest";
import "@fontsource-variable/unbounded";
import "./globals.css";
import { siteConfig } from "@/lib/config";

const title = "AutoFlow — заявки и запись клиентов для автосервисов";
const description =
  "AutoFlow принимает заявки и записывает клиентов автосервиса без звонков: публичная страница записи, расписание, уведомления, кабинет и Android-приложение. Набираем автосервисы на пилот.";

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.url),
  title,
  description,
  applicationName: "AutoFlow",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    locale: "ru_RU",
    siteName: "AutoFlow",
    url: "/",
    title,
    description,
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "AutoFlow — запись клиентов для автосервисов" }],
  },
  twitter: { card: "summary_large_image", title, description, images: ["/og.png"] },
};

export const viewport: Viewport = { themeColor: "#fbf7f0", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
