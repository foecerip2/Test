import { expect, test } from "@playwright/test";
import { settle } from "./helpers";

// Production-сборка (без NEXT_PUBLIC_DEV_FIXTURES): API ещё не подключён, поэтому интерфейс обязан честно
// показывать ошибку и НИКОГДА — демо-данные и «успешные» операции.
const FORBIDDEN = /Демо-данные|demo-web|demo-staging|demo-archive|203\.0\.113|BETA-7QK2|dev-фикстур/i;

for (const route of ["/dashboard", "/servers", "/servers/srv_demo_web1", "/operations", "/monitoring", "/billing", "/settings", "/deploy", "/admin", "/operations/op_x/approve"]) {
  test(`production: ${route} — честное состояние ошибки, без демо-данных`, async ({ page }) => {
    await page.goto(route);
    await settle(page);
    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(FORBIDDEN);
    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(page.getByText("Сервис недоступен").first()).toBeVisible();
  });
}

test("production: нет ribbon «Демо-данные» и моков в HTML", async ({ page, request }) => {
  const html = await (await request.get("/login")).text();
  expect(html).not.toMatch(/Демо-данные|Демо-вход/);
  await page.goto("/login");
  await expect(page.getByText("Демо-вход")).toHaveCount(0);
});

test("production: вход без бэкенда → понятная ошибка, редиректа на dashboard нет", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Пароль", { exact: true }).fill("correct-horse-battery");
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByText("Серверная часть ServerMind недоступна")).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test("production: фикстуры не отдаются как статические файлы", async ({ request, page }) => {
  await page.goto("/dashboard");
  const scripts = await page.evaluate(() => Array.from(document.scripts).map((s) => s.src).filter(Boolean));
  for (const src of scripts) {
    const body = await (await request.get(src)).text();
    expect(body, src).not.toMatch(/demo-web-1|seedServers|mulberry32/);
  }
});

test("production: добавление сервера — ошибка, а не «успех»", async ({ page }) => {
  await page.goto("/servers/new");
  await settle(page);
  await expect(page.getByText("Сервис недоступен").first()).toBeVisible(); // публичный ключ ServerMind недоступен
  await page.getByLabel("IP-адрес или домен").fill("203.0.113.50");
  await page.getByRole("button", { name: "Получить отпечаток сервера" }).click();
  await expect(page.getByText("Не удалось получить отпечаток")).toBeVisible();
  await expect(page.getByText("Сервер подключён")).toHaveCount(0);
});
