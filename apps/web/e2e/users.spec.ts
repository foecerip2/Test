import { expect, test, type Page } from "@playwright/test";

/** Вход по демо-коду. owner@… — владелец, остальные — обычные активные пользователи. */
async function login(page: Page, email: string, query = "") {
  await page.goto(`/login${query}`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Получить код" }).click();
  await page.getByLabel("Цифра 1 из 6").waitFor();
  await page.keyboard.type("123456");
  await page.waitForURL("**/overview");
}

async function openSettings(page: Page, isMobile: boolean) {
  if (isMobile) await page.getByRole("button", { name: "Открыть меню" }).click();
  await page.getByRole("navigation").getByRole("link", { name: "Настройки" }).click();
  await page.waitForURL("**/settings");
}

/** Переход в Настройки → Пользователи без перезагрузки (состояние mock живёт в памяти страницы). */
async function gotoUsersTab(page: Page, isMobile: boolean) {
  await openSettings(page, isMobile);
  await page.getByRole("tab", { name: "Пользователи" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Пользователи" })).toBeVisible();
  await expect(page.locator("table.users-table")).toBeVisible();
}

const rows = (page: Page) => page.locator("table.users-table tbody tr");
const row = (page: Page, email: string) => rows(page).filter({ hasText: email });
const pendingValue = (page: Page) => page.locator(".users-metrics .metric").first().locator(".metric-value");

test.describe("Настройки → Пользователи (владелец)", () => {
  test("вкладка видна, сводка и список: сначала ожидающие, email целиком", async ({ page, isMobile }) => {
    await login(page, "owner@example.com");
    await gotoUsersTab(page, isMobile);
    await expect(page.locator(".users-metrics")).toContainText("Ожидают одобрения");
    await expect(pendingValue(page)).toHaveText("3");
    // Первые три строки — ожидающие, в конце — заблокированный.
    await expect(rows(page)).toHaveCount(7);
    for (const i of [0, 1, 2]) await expect(rows(page).nth(i)).toHaveAttribute("data-user-status", "pending");
    await expect(rows(page).nth(6)).toHaveAttribute("data-user-status", "blocked");
    // Email показан полностью (владелец), статус — текстом.
    await expect(page.getByText("very.long.email.address.for.layout.check@department.subdomain.example.com")).toBeVisible();
    await expect(row(page, "maria.sokolova@example.com")).toContainText("Ожидает одобрения");
    await expect(row(page, "anna.petrova@example.com")).toContainText("Активен");
    await expect(row(page, "spam.test@example.net")).toContainText("Заблокирован");
    await expect(row(page, "owner@example.com")).toContainText("Это вы");
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(over, "горизонтальный скролл").toBeLessThanOrEqual(0);
  });

  test("одобрение через диалог подтверждения", async ({ page, isMobile }) => {
    await login(page, "owner@example.com");
    await gotoUsersTab(page, isMobile);
    await page.getByRole("button", { name: "Одобрить: maria.sokolova@example.com" }).click();
    const dialog = page.getByRole("dialog", { name: "Одобрить доступ?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("maria.sokolova@example.com");
    await expect(dialog.getByRole("button", { name: "Отмена" })).toBeFocused();
    await dialog.getByRole("button", { name: "Одобрить" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Доступ одобрен: maria.sokolova@example.com")).toBeVisible();
    await expect(row(page, "maria.sokolova@example.com")).toContainText("Активен");
    await expect(pendingValue(page)).toHaveText("2");
  });

  test("блокировка: диалог объясняет последствия, Esc отменяет, подтверждение блокирует", async ({ page, isMobile }) => {
    await login(page, "owner@example.com");
    await gotoUsersTab(page, isMobile);
    const block = page.getByRole("button", { name: "Заблокировать: anna.petrova@example.com" });
    await block.click();
    const dialog = page.getByRole("dialog", { name: "Заблокировать пользователя?" });
    await expect(dialog).toContainText("сессии");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(row(page, "anna.petrova@example.com")).toContainText("Активен");

    await block.click();
    await dialog.getByRole("button", { name: "Заблокировать" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("Пользователь заблокирован: anna.petrova@example.com")).toBeVisible();
    await expect(row(page, "anna.petrova@example.com")).toContainText("Заблокирован");
    // Заблокированного можно вернуть: «Одобрить».
    await expect(page.getByRole("button", { name: "Одобрить: anna.petrova@example.com" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Заблокировать: anna.petrova@example.com" })).toHaveCount(0);
  });

  test("себя заблокировать нельзя: кнопка выключена, причина видна", async ({ page, isMobile }) => {
    await login(page, "owner@example.com");
    await gotoUsersTab(page, isMobile);
    const self = page.getByRole("button", { name: "Заблокировать: owner@example.com" });
    await expect(self).toBeDisabled();
    await expect(self).toHaveAccessibleDescription("Нельзя заблокировать себя");
    await expect(row(page, "owner@example.com")).toContainText("Нельзя заблокировать себя");
  });

  test("ошибка LAST_OWNER от сервера показана понятным текстом", async ({ page, isMobile }) => {
    await login(page, "owner@example.com", "?mock=lastowner");
    await gotoUsersTab(page, isMobile);
    await page.getByRole("button", { name: "Заблокировать: co-owner@example.com" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Заблокировать" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "последнего владельца" })).toBeVisible();
    await expect(row(page, "co-owner@example.com")).toContainText("Активен");
  });

  test("фильтр по статусу", async ({ page, isMobile }) => {
    await login(page, "owner@example.com");
    await gotoUsersTab(page, isMobile);
    await page.getByLabel("Статус", { exact: true }).selectOption("blocked");
    await expect(rows(page)).toHaveCount(1);
    await expect(page.getByText("spam.test@example.net")).toBeVisible();
    await page.getByLabel("Статус", { exact: true }).selectOption("pending");
    await expect(rows(page)).toHaveCount(3);
  });

  test("ожидающие видны в обзоре и в колокольчике, ссылки ведут во вкладку", async ({ page }) => {
    await login(page, "owner@example.com");
    await expect(page.getByTestId("pending-users")).toContainText("3 пользователя ждут одобрения");
    await page.getByRole("button", { name: /^Уведомления/ }).click();
    const link = page.getByRole("region", { name: "Уведомления" }).getByRole("link", { name: "3 пользователя ждут одобрения" });
    await expect(link).toBeVisible();
    await link.click();
    await page.waitForURL("**/settings?tab=users");
    await expect(page.getByRole("tab", { name: "Пользователи" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("table.users-table")).toBeVisible();
  });

  test("состояние ошибки с повтором", async ({ page, isMobile }) => {
    await login(page, "owner@example.com", "?mock=error");
    await openSettings(page, isMobile);
    await page.getByRole("tab", { name: "Пользователи" }).click();
    await expect(page.getByRole("heading", { name: "Не удалось загрузить данные" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Повторить" })).toBeVisible();
  });
});

test.describe("мобильные карточки", () => {
  test("кнопки не меньше 44 px, заголовок таблицы скрыт", async ({ page, isMobile }) => {
    test.skip(!isMobile, "только мобильный вьюпорт");
    await login(page, "owner@example.com");
    await gotoUsersTab(page, true);
    // Заголовок скрыт визуально (остаётся для скринридеров), данные идут карточками.
    expect((await page.locator("table.users-table thead").boundingBox())!.width).toBeLessThanOrEqual(1);
    for (const name of ["Одобрить: maria.sokolova@example.com", "Заблокировать: maria.sokolova@example.com"]) {
      const box = await page.getByRole("button", { name }).boundingBox();
      expect(box!.height, name).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe("обычный пользователь", () => {
  test("вкладки нет, прямая ссылка даёт «Нет доступа», ожидающих не видит", async ({ page }) => {
    await login(page, "anna@example.com");
    await expect(page.getByTestId("pending-users")).toHaveCount(0);
    await page.goto("/settings");
    await expect(page.getByRole("tab", { name: "AI" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Пользователи" })).toHaveCount(0);
    await page.goto("/settings?tab=users");
    await expect(page.getByRole("heading", { name: "Нет доступа" })).toBeVisible();
    await expect(page.locator("table.users-table")).toHaveCount(0);
  });
});
