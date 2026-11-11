import { expect, test, type Page } from "@playwright/test";

const CODE = "123456";

async function openCodeDialog(page: Page, email = "anna@example.com", path = "/login") {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Получить код" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel("Цифра 1 из 6")).toBeFocused();
  return dialog;
}

const cell = (page: Page, n: number) => page.getByLabel(`Цифра ${n} из 6`);
async function filled(page: Page): Promise<string> {
  return (await Promise.all([1, 2, 3, 4, 5, 6].map((n) => cell(page, n).inputValue()))).join("");
}

test.describe("вход по email и коду", () => {
  test("email → код 123456 → анимация успеха → обзор", async ({ page, isMobile }) => {
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { level: 1, name: "Войти или создать аккаунт" })).toBeVisible();
    await expect(page.getByText("Пароль не нужен")).toBeVisible();
    const email = page.getByLabel("Email");
    await expect(email).toHaveAttribute("autocomplete", "email");
    await expect(email).toHaveAttribute("inputmode", "email");
    await email.fill("anna@example.com");
    await page.getByRole("button", { name: "Получить код" }).click();

    const dialog = page.getByRole("dialog", { name: "Введите код из письма" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog).toContainText("a***@example.com");
    await expect(dialog.getByRole("button", { name: "Изменить email" })).toBeVisible();
    await expect(dialog.getByText("Демо: код")).toBeVisible();
    await expect(dialog.getByRole("group", { name: "Код подтверждения, 6 цифр" })).toBeVisible();
    await expect(cell(page, 1)).toHaveAttribute("autocomplete", "one-time-code");
    await expect(cell(page, 1)).toHaveAttribute("inputmode", "numeric");

    // Размеры: на телефоне — нижний лист, ячейки не меньше 44 px; на десктопе — карточка по центру.
    const box = (await dialog.boundingBox())!;
    const vp = page.viewportSize()!;
    const c1 = (await cell(page, 1).boundingBox())!;
    if (isMobile) {
      expect(box.width).toBeGreaterThanOrEqual(vp.width - 1);
      expect(box.y + box.height).toBeGreaterThanOrEqual(vp.height - 2);
      expect(c1.width).toBeGreaterThanOrEqual(44);
      expect(c1.height).toBeGreaterThanOrEqual(44);
    } else {
      expect(box.width).toBeLessThanOrEqual(460);
      expect(Math.abs(box.x + box.width / 2 - vp.width / 2)).toBeLessThan(2);
    }

    await page.keyboard.type(CODE);
    // Анимация успеха: круг с галочкой и подпись, затем переход.
    await expect(page.locator("[data-badge]")).toBeVisible();
    await expect(page.getByRole("dialog").getByText("Аккаунт создан", { exact: true })).toBeVisible();
    await page.waitForURL("**/overview", { timeout: 5000 });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(over).toBeLessThanOrEqual(0);
  });

  test("выход и повторный вход того же email: «Готово — добро пожаловать»", async ({ page, isMobile }) => {
    await openCodeDialog(page, "owner@example.com");
    await page.keyboard.type(CODE);
    await page.waitForURL("**/overview");
    if (isMobile) await page.getByRole("button", { name: "Открыть меню" }).click();
    await page.getByRole("button", { name: /меню профиля/ }).click();
    await page.getByRole("menuitem", { name: "Выйти" }).click();
    await page.waitForURL("**/login");
    await page.getByLabel("Email").fill("owner@example.com");
    await page.getByRole("button", { name: "Получить код" }).click();
    await expect(page.getByLabel("Цифра 1 из 6")).toBeFocused();
    await page.keyboard.type(CODE);
    await expect(page.getByRole("dialog").getByText("Готово — добро пожаловать", { exact: true })).toBeVisible();
    await page.waitForURL("**/overview");
  });

  test("неверный код: ошибка с числом попыток, ячейки очищаются, фокус на первой", async ({ page }) => {
    const dialog = await openCodeDialog(page);
    await page.keyboard.type("000000");
    const alert = dialog.getByRole("alert").filter({ hasText: "Неверный код" });
    await expect(alert).toHaveText("Неверный код. Осталось попыток: 4");
    expect(await filled(page)).toBe("");
    await expect(cell(page, 1)).toBeFocused();
    await expect(cell(page, 1)).toHaveAttribute("aria-invalid", "true");
    await page.keyboard.type("111111");
    await expect(alert).toHaveText("Неверный код. Осталось попыток: 3");
    // Фокус возвращается на первую ячейку в следующем кадре — ждём его, иначе ввод может уйти «в никуда».
    await expect(cell(page, 1)).toBeFocused();
    // Ошибка исчезает, как только начат новый ввод.
    await page.keyboard.type("1");
    await expect(dialog.getByRole("alert").filter({ hasText: "Неверный код" })).toHaveCount(0);
    // И верный код всё ещё принимается.
    await page.keyboard.press("Backspace");
    await page.keyboard.type(CODE);
    await page.waitForURL("**/overview");
  });

  test("лимит попыток: блокировка и новый код после ожидания", async ({ page }) => {
    const dialog = await openCodeDialog(page, "anna@example.com", "/login?mock=fastresend");
    for (let i = 0; i < 4; i++) {
      await page.keyboard.type("000000");
      await expect(dialog.getByRole("alert")).toContainText(`Осталось попыток: ${4 - i}`);
      await expect(cell(page, 1)).toBeFocused();
    }
    await page.keyboard.type("000000");
    await expect(dialog.getByRole("alert")).toContainText("Слишком много неверных попыток");
    await expect(cell(page, 1)).toBeDisabled();
    const again = dialog.getByRole("button", { name: "Отправить новый код" });
    await expect(again).toBeVisible({ timeout: 6000 });
    await again.click();
    await expect(dialog.getByRole("status").filter({ hasText: "Новый код отправлен" })).toBeVisible();
    await expect(cell(page, 1)).toBeEnabled();
    await expect(cell(page, 1)).toBeFocused();
    await page.keyboard.type(CODE);
    await page.waitForURL("**/overview");
  });

  test("вставка кода целиком (paste) в любую ячейку", async ({ page }) => {
    await openCodeDialog(page);
    await cell(page, 4).evaluate((el, text) => {
      const dt = new DataTransfer();
      dt.setData("text", text);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, "123 456");
    await expect(page.locator("[data-badge]")).toBeVisible();
    await page.waitForURL("**/overview");
  });

  test("ввод только цифр, Backspace и стрелки", async ({ page }) => {
    await openCodeDialog(page);
    await page.keyboard.type("1a2b3");
    expect(await filled(page)).toBe("123");
    await expect(cell(page, 4)).toBeFocused();
    await page.keyboard.press("Backspace"); // пустая 4-я → очищает 3-ю и уходит назад
    expect(await filled(page)).toBe("12");
    await expect(cell(page, 3)).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(cell(page, 2)).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(cell(page, 3)).toBeFocused();
    await page.keyboard.type("456");
    expect(await filled(page)).toBe("12456");
    await expect(cell(page, 6)).toBeFocused();
    await page.keyboard.type("3");
    expect(await filled(page)).toBe("124563"); // шесть цифр → автоотправка (код неверный)
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Неверный код");
  });

  test("повторная отправка: отсчёт и активная кнопка (?mock=fastresend)", async ({ page }) => {
    const dialog = await openCodeDialog(page, "anna@example.com", "/login?mock=fastresend");
    await expect(dialog.getByText(/Отправить код ещё раз через 0:0\d/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Отправить код ещё раз" })).toHaveCount(0);
    const btn = dialog.getByRole("button", { name: "Отправить код ещё раз" });
    await expect(btn).toBeVisible({ timeout: 6000 });
    await btn.click();
    await expect(dialog.getByRole("status").filter({ hasText: "Новый код отправлен" })).toBeVisible();
    // Отсчёт запустился заново.
    await expect(dialog.getByText(/Отправить код ещё раз через 0:0\d/)).toBeVisible();
  });

  test("срок действия кода истёк (?mock=fastexpire)", async ({ page }) => {
    const dialog = await openCodeDialog(page, "anna@example.com", "/login?mock=fastexpire,fastresend");
    await expect(dialog.getByRole("alert")).toContainText("Срок действия кода истёк", { timeout: 9000 });
    await expect(cell(page, 1)).toBeDisabled();
    const again = dialog.getByRole("button", { name: "Отправить новый код" });
    await expect(again).toBeVisible();
    await again.click();
    await expect(cell(page, 1)).toBeEnabled();
    await page.keyboard.type(CODE);
    await page.waitForURL("**/overview");
  });

  test("ошибка отправки письма (?mock=mailerror) и неверный формат email", async ({ page }) => {
    await page.goto("/login?mock=mailerror");
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Email").fill("не-почта");
    await page.getByRole("button", { name: "Получить код" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Проверьте адрес" })).toBeVisible();
    await page.getByLabel("Email").fill("anna@example.com");
    await page.getByRole("button", { name: "Получить код" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Не удалось отправить письмо" })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("Esc закрывает окно и возвращает фокус; «Изменить email» возвращает к вводу", async ({ page }) => {
    const dialog = await openCodeDialog(page);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    // Фокус вернулся в форму (поле email).
    await expect(page.getByLabel("Email")).toBeFocused();
    await page.getByRole("button", { name: "Получить код" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Изменить email" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByLabel("Email")).toBeFocused();
    await expect(page.getByLabel("Email")).toHaveValue("anna@example.com");
  });

  test("фокус заперт внутри окна", async ({ page }) => {
    const dialog = await openCodeDialog(page);
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
  });
});

test.describe("статус аккаунта", () => {
  test("pending: экран ожидания одобрения, проверка и выход", async ({ page }) => {
    await openCodeDialog(page, "pending.user@example.com");
    await page.keyboard.type(CODE);
    await page.waitForURL("**/overview");
    await expect(page.getByRole("heading", { level: 1, name: "Аккаунт ожидает одобрения владельцем" })).toBeVisible();
    await page.getByRole("button", { name: "Проверить снова" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Пока без изменений" })).toBeVisible();
    // Рабочее пространство недоступно: навигации нет.
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await page.getByRole("button", { name: "Выйти" }).click();
    await page.waitForURL("**/login");
    await page.goto("/companies");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("blocked: экран блокировки", async ({ page }) => {
    await openCodeDialog(page, "blocked@example.com");
    await page.keyboard.type(CODE);
    await page.waitForURL("**/overview");
    await expect(page.getByRole("heading", { level: 1, name: "Доступ к аккаунту закрыт" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Выйти" })).toBeVisible();
  });
});

test.describe("уменьшение движения", () => {
  test("prefers-reduced-motion: без анимаций, сразу круг с галочкой и переход", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openCodeDialog(page);
    await page.keyboard.type(CODE);
    const badge = page.locator("[data-badge]");
    await expect(badge).toBeVisible();
    // Анимации отключены: галочка нарисована сразу, переходов у ячеек нет.
    const info = await page.evaluate(() => {
      const tick = document.querySelector("[data-badge] path")!;
      const c = document.querySelector("input")!;
      return { anim: getComputedStyle(tick).animationName, dash: getComputedStyle(tick).strokeDashoffset, tr: getComputedStyle(c).transitionDuration };
    });
    expect(info.anim).toBe("none");
    expect(parseFloat(info.dash)).toBe(0);
    expect(info.tr.split(",").every((x) => parseFloat(x) === 0)).toBe(true);
    await page.waitForURL("**/overview", { timeout: 4000 });
  });
});
