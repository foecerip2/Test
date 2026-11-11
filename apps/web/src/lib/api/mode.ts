/** Режим данных: live — рабочий сервер без демо-данных, demo — демонстрационные данные в памяти (разработка и автотесты). */
export type DataMode = "demo" | "live";

/**
 * NEXT_PUBLIC_DATA_MODE=live|mock главнее; если не задана — признаком live служит NEXT_PUBLIC_AUTH_MODE=live,
 * чтобы продакшн-сборка с живым входом сразу показывала настоящие данные, а не демо.
 * В сборке то же правило применяет next.config.ts (env), поэтому в live-бандле демо-код вырезается целиком.
 */
export function resolveDataMode(dataMode?: string | null, authMode?: string | null): DataMode {
  const d = (dataMode ?? "").trim().toLowerCase();
  if (d === "live") return "live";
  if (d) return "demo";
  return (authMode ?? "").trim().toLowerCase() === "live" ? "live" : "demo";
}
