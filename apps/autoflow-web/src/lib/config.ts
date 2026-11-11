/**
 * Конфигурация лендинга. NEXT_PUBLIC_* подставляются при сборке (docker build --build-arg), поэтому читаются статически.
 * Контакты по умолчанию — заглушки на домене .example: перед запуском рекламы владелец задаёт настоящие.
 */
export type ApiMode = "live" | "mock";

export const siteConfig = {
  name: "AutoFlow",
  url: (process.env.NEXT_PUBLIC_SITE_URL || "https://autoflow.vaylonet.ru").replace(/\/+$/, ""),
  apiMode: (process.env.NEXT_PUBLIC_API_MODE === "mock" ? "mock" : "live") as ApiMode,
  contactEmail: process.env.NEXT_PUBLIC_CONTACT_EMAIL || "hello@autoflow.example",
  contactTelegram: process.env.NEXT_PUBLIC_CONTACT_TELEGRAM || "",
  operator: process.env.NEXT_PUBLIC_OPERATOR_NAME || "[наименование оператора — заполнить]",
  /** Адрес приёма заявок на пилот (сервер появится отдельным шагом). */
  pilotEndpoint: "/api/v1/autoflow/pilot-requests",
} as const;
