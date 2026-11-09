import { defineConfig, devices } from "@playwright/test";

/**
 * Два режима сборки:
 *  - fixtures (порт 3100): `npm run build:fixtures && npm run start:fixtures` — экраны с явно помеченными демо-данными;
 *  - production (порт 3200): обычная `npm run build` — без фикстур, API недоступен → честные error-состояния.
 * Браузер: предустановленный Chromium из окружения (без `playwright install`).
 */
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/output",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    trace: "off",
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    // Предустановленный Chromium в окружении не совпадает по сборке с версией Playwright, поэтому путь задаётся явно
    // (переменная PW_CHROMIUM_PATH, по умолчанию — путь из облачной среды). В CI используйте `playwright install chromium`.
    launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH ?? (process.env.CI ? undefined : "/opt/pw-browsers/chromium"), args: ["--no-sandbox"] },
  },
  projects: [
    { name: "fixtures", testMatch: /(screens|flows|shots)\.spec\.ts/, use: { baseURL: "http://localhost:3100" } },
    { name: "production", testMatch: /production\.spec\.ts/, use: { baseURL: "http://localhost:3200" } },
  ],
  webServer: [
    { command: "npm run start:fixtures", url: "http://localhost:3100/login", reuseExistingServer: true, timeout: 60_000 },
    { command: "npm run start:prod", url: "http://localhost:3200/login", reuseExistingServer: true, timeout: 60_000 },
  ],
});
