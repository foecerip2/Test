import { defineConfig, devices } from "@playwright/test";

/**
 * Два набора сборок:
 *  - mock (порт 3100): обычная `pnpm build`, демо-данные и вход по коду 123456; тесты в e2e/*.spec.ts;
 *  - live (порт 3101): отдельная сборка NEXT_PUBLIC_AUTH_MODE=live + NEXT_PUBLIC_DATA_MODE=live в каталоге .next-live,
 *    сеть /api/v1/* подменяется в тестах (e2e/live/*.spec.ts) ответами в формате реального сервера.
 * `pnpm e2e` запускает оба; сборку live собирает сам webServer (около минуты), отдельный шаг в CI не нужен.
 */
const MOCK = "http://localhost:3100";
const LIVE = "http://localhost:3101";
const desktop = { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } };
const mobile = { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: "list",
  use: { baseURL: MOCK, trace: "off" },
  webServer: [
    {
      command: "pnpm exec next start -p 3100",
      url: `${MOCK}/login`,
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: "pnpm exec next build && pnpm exec next start -p 3101",
      url: `${LIVE}/login`,
      reuseExistingServer: true,
      timeout: 300_000,
      env: { NEXT_PUBLIC_AUTH_MODE: "live", NEXT_PUBLIC_DATA_MODE: "live", NEXT_DIST_DIR: ".next-live", NEXT_TELEMETRY_DISABLED: "1" },
    },
  ],
  projects: [
    { name: "desktop", testIgnore: "**/live/**", use: desktop },
    { name: "mobile", testIgnore: "**/live/**", use: mobile },
    { name: "live-desktop", testMatch: "**/live/**/*.spec.ts", use: { ...desktop, baseURL: LIVE } },
    { name: "live-mobile", testMatch: "**/live/**/*.spec.ts", use: { ...mobile, baseURL: LIVE } },
  ],
});
