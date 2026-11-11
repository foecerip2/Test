import { expect, test, type Page } from "@playwright/test";

/** Вход по email и демо-коду 123456 (подробные сценарии — в auth.spec.ts). */
async function login(page: Page, path = "/login") {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByRole("button", { name: "Получить код" }).click();
  await page.getByLabel("Цифра 1 из 6").waitFor();
  await page.keyboard.type("123456");
  await page.waitForURL("**/overview");
}

test.describe("вход", () => {
  test("вход по email и коду ведёт в обзор", async ({ page }) => {
    await login(page);
    await expect(page).toHaveURL(/\/overview$/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("без сессии защищённая страница перенаправляет на /login", async ({ page }) => {
    await page.goto("/companies");
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("навигация и адаптив", () => {
  test("доступны все восемь разделов, нет горизонтальной прокрутки", async ({ page, isMobile }) => {
    await login(page);
    if (isMobile) await page.getByRole("button", { name: "Открыть меню" }).click();
    const nav = page.getByRole("navigation");
    for (const name of ["Обзор", "Поиск компаний", "База компаний", "Согласование", "Диалоги", "Воронка продаж", "Аналитика", "Настройки"]) {
      await expect(nav.getByRole("link", { name })).toBeVisible();
    }
    if (isMobile) await page.keyboard.press("Escape");
    for (const r of ["overview", "discovery", "companies", "approvals", "inbox", "pipeline", "analytics", "settings"]) {
      await page.goto("/" + r);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(over, `горизонтальный скролл на /${r}`).toBeLessThanOrEqual(0);
    }
  });

  test("мобильное меню закрывается по Escape", async ({ page, isMobile }) => {
    test.skip(!isMobile, "только мобильный вьюпорт");
    await login(page);
    const btn = page.getByRole("button", { name: "Открыть меню" });
    await btn.click();
    await expect(btn).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(btn).toHaveAttribute("aria-expanded", "false");
  });
});

test.describe("компании", () => {
  test("поиск фильтрует, карточка отделяет факты от гипотез", async ({ page }) => {
    await login(page);
    await page.goto("/companies");
    await page.getByLabel("Поиск по компаниям").fill("Казань");
    await expect(page.getByRole("link", { name: "Автоцентр «Пятый бокс»", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "СТО «Северный мотор»", exact: true })).toHaveCount(0);
    await page.getByLabel("Поиск по компаниям").fill("Северный");
    await page.getByRole("link", { name: "СТО «Северный мотор»", exact: true }).click();
    await expect(page.getByText("Подтверждённые факты")).toBeVisible();
    await expect(page.getByText("Гипотезы (требуют проверки)")).toBeVisible();
    await expect(page.getByText("Согласие не подтверждено")).toBeVisible();
  });
});

test.describe("согласование и право отправки", () => {
  test("отправка заблокирована без согласия; одобрение текста её не разблокирует", async ({ page }) => {
    await login(page);
    await page.goto("/approvals");
    const send = page.getByRole("button", { name: "Отправить", exact: true });
    await expect(send).toBeDisabled();
    await page.getByRole("button", { name: "Согласовать текст" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("согласие");
    await dialog.getByRole("button", { name: "Согласовать текст" }).click();
    await expect(dialog).toBeHidden();
    await expect(send).toBeDisabled();
    await expect(page.getByText("Согласие адресата не подтверждено").first()).toBeVisible();
  });

  test("правка текста после согласования требует повторного согласования", async ({ page }) => {
    await login(page);
    await page.goto("/approvals");
    await page.getByRole("button", { name: "Согласовать текст" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Согласовать текст" }).click();
    const body = page.getByLabel("Текст для согласования");
    await body.fill((await body.inputValue()) + " Дополнение.");
    await page.getByRole("button", { name: "Сохранить" }).click();
    await expect(page.getByText(/устарело|изменён после согласования/i).first()).toBeVisible();
  });
});

test.describe("диалоги", () => {
  test("отписка требует подтверждения и необратима", async ({ page }) => {
    await login(page);
    await page.goto("/inbox");
    await page.getByText("«МоторЛайн»").first().click();
    const sel = page.getByLabel(/Класс ответа/);
    await sel.selectOption({ label: "Отписка" });
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("необратимо");
    await dialog.getByRole("button", { name: "Отметить отписку" }).click();
    await expect(dialog).toBeHidden();
    await sel.selectOption({ label: "Заинтересован" });
    await expect(page.getByText(/необратима/i).first()).toBeVisible();
  });
});

test.describe("состояния", () => {
  test("пустая база показывает EmptyState без выдуманных метрик", async ({ page }) => {
    await login(page, "/login?mock=empty");
    await expect(page.getByText("Импортировать CSV").first()).toBeVisible();
  });

  test("ошибка API показывает ErrorState с повтором", async ({ page }) => {
    await login(page, "/login?mock=error");
    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Повторить" }).first()).toBeVisible();
  });
});
