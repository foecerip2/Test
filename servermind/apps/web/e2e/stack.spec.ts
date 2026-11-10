import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";

// Сквозная проверка РЕАЛЬНОГО стека без фикстур: браузер → Next (rewrites) → FastAPI → PostgreSQL.
// Нужны: API на :8010, веб-сборка с API_BASE_URL на :3300, пользователь owner@example.com (см. README, «stack e2e»).
const EMAIL = "owner@example.com";
const PASSWORD = process.env.STACK_PASSWORD ?? "stack-test-password-123";

function base32(s: string): Buffer {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of s.replace(/=+$/, "").toUpperCase()) bits += A.indexOf(c).toString(2).padStart(5, "0");
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

/** RFC 6238 (SHA-1, 6 цифр, шаг 30 с) */
function totp(secret: string, offsetSteps = 0): string {
  const counter = Math.floor(Date.now() / 30000) + offsetSteps;
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32(secret)).update(buf).digest();
  const o = h[h.length - 1]! & 0xf;
  const n = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, "0");
}

test.describe.configure({ mode: "serial" });

test("реальный стек: вход → обязательная настройка 2FA → пустой дашборд без демо-данных", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Пароль", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Настройка 2FA" })).toBeVisible();
  const secret = (await page.getByTestId("totp-secret").innerText()).trim();
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);

  await page.getByRole("textbox", { name: "Код из приложения" }).fill("000000");
  await page.getByRole("button", { name: "Включить 2FA и войти" }).click();
  await expect(page.getByText("Неверный код.")).toBeVisible();

  await page.getByRole("textbox", { name: "Код из приложения" }).fill(totp(secret));
  await page.getByRole("button", { name: "Включить 2FA и войти" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByText("Серверов пока нет")).toBeVisible();
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/Демо-данные|demo-/i);
  await expect(page.getByText(EMAIL)).toBeVisible(); // реальный пользователь из /me
  test.info().annotations.push({ type: "totp-secret", description: "not-recorded" });
  process.env.STACK_TOTP_SECRET = secret;
});

test("реальный стек: публичный ключ сервиса и мутация с CSRF после перезагрузки страницы", async ({ page }) => {
  // новая страница = новый контекст без сессии → нужен вход с 2FA (код следующего шага: код текущего уже использован)
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Пароль", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Код подтверждения" })).toBeVisible();
  const secret = process.env.STACK_TOTP_SECRET!;
  await page.getByRole("textbox", { name: "Код" }).fill(totp(secret, 1)); // шаг +1: допускается окном ±1, прежний шаг уже занят (replay)
  await page.getByRole("button", { name: "Подтвердить" }).click();
  await expect(page).toHaveURL(/\/dashboard/);

  await page.goto("/servers/new");
  const key = page.getByLabel("Публичный SSH-ключ ServerMind");
  await expect(key).toContainText("ssh-ed25519 ");
  expect(await key.innerText()).not.toMatch(/DEMO|MOCK/i);
  await expect(page.getByText("Демо-ключ")).toHaveCount(0);

  // страница загружена заново → CSRF-токен восстанавливается через GET /me; без него API ответил бы 403 csrf
  await page.getByLabel("IP-адрес или домен").fill("8.8.8.8");
  await page.getByLabel("Порт SSH").fill("1999"); // закрытый порт у публичного адреса не нужен: политика/сеть ответят быстро
  await page.getByRole("button", { name: "Получить отпечаток сервера" }).click();
  const alert = page.getByRole("alert").filter({ hasText: "Не удалось получить отпечаток" });
  await expect(alert).toBeVisible({ timeout: 30_000 });
  await expect(alert).not.toContainText("CSRF");
});

test("реальный стек: выход закрывает доступ", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Пароль", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await page.getByRole("textbox", { name: "Код" }).fill(totp(process.env.STACK_TOTP_SECRET!, -1));
  await page.getByRole("button", { name: "Подтвердить" }).click();
  await expect(page.getByRole("alert").getByText("Неверный код.")).toBeVisible(); // шаг −1 уже использован ранее → replay отклонён
  await page.goto("/dashboard");
  await expect(page.getByText("Введите код двухфакторной аутентификации.").first()).toBeVisible(); // сессия в стадии 2FA → API не отдаёт данные
});
