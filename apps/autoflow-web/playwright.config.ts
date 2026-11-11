import { defineConfig, devices } from "@playwright/test";

/**
 * Один набор: обычная сборка (режим API live по умолчанию), сеть /api/v1/autoflow/* подменяется в тестах
 * через page.route — так проверяется настоящий fetch-путь формы. Порт 3300 (LeadHunter web: 3100/3101).
 */
const BASE = "http://localhost:3300";
const desktop = { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } };
const mobile = { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: "list",
  use: { baseURL: BASE, trace: "off" },
  webServer: {
    command: "pnpm exec next start -p 3300",
    url: BASE,
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [
    { name: "desktop", use: desktop },
    { name: "mobile", use: mobile },
  ],
});
