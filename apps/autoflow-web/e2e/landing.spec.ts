import { expect, test, type Page, type Route } from "@playwright/test";

const ENDPOINT = "**/api/v1/autoflow/pilot-requests";

async function fill(page: Page, over: Partial<Record<"business" | "city" | "name" | "phone" | "email", string>> = {}) {
  const v = { business: "Автосервис Пример", city: "Казань", name: "Иван", phone: "+7 900 000-00-00", email: "", ...over };
  await page.getByLabel("Название автосервиса").fill(v.business);
  await page.getByLabel("Город").fill(v.city);
  await page.getByLabel("Ваше имя").fill(v.name);
  await page.getByLabel("Телефон").fill(v.phone);
  await page.getByLabel("E-mail").fill(v.email);
}

test.describe("лендинг AutoFlow", () => {
  test("главная: смысл на первом экране, разделы, цены не выдуманы", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Запись клиентов");
    await expect(page.getByRole("link", { name: "Хочу пилот" }).first()).toBeVisible();
    for (const name of ["Три шага от клика до записи в расписании", "Что войдёт в AutoFlow сначала", "Частые вопросы"]) {
      await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
    }
    await expect(page.getByText("Условия пилота обсуждаются").first()).toBeVisible();
    await expect(page.locator("body")).not.toContainText("₽");
    // Нет горизонтальной прокрутки
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("метаданные, robots и sitemap", async ({ page, request }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/AutoFlow/);
    await expect(page.locator('meta[property="og:image"]')).toHaveCount(1);
    await expect(page.locator('meta[name="description"]')).toHaveCount(1);
    expect((await request.get("/robots.txt")).ok()).toBe(true);
    expect(await (await request.get("/sitemap.xml")).text()).toContain("/privacy");
    expect((await request.get("/og.png")).ok()).toBe(true);
  });

  test("политика: черновик помечен", async ({ page }) => {
    await page.goto("/privacy");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Политика обработки персональных данных");
    await expect(page.getByRole("note")).toContainText("проверить у юриста");
  });

  test("FAQ раскрывается с клавиатуры", async ({ page }) => {
    await page.goto("/#faq");
    const first = page.locator("details").first();
    await first.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(first).toHaveAttribute("open", "");
  });

  test("ссылка пропуска первой в порядке Tab", async ({ page, isMobile }) => {
    test.skip(isMobile, "клавиатура на десктопе");
    await page.goto("/");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Перейти к содержимому" })).toBeFocused();
  });
});

test.describe("форма «Хочу пилот»", () => {
  test("пустая отправка: ошибки под полями, фокус на первом", async ({ page }) => {
    await page.goto("/#pilot");
    await page.getByRole("button", { name: "Отправить заявку" }).click();
    await expect(page.getByLabel("Название автосервиса")).toBeFocused();
    await expect(page.getByText("Укажите название автосервиса")).toBeVisible();
    await expect(page.getByText("Оставьте телефон или e-mail")).toBeVisible();
    await expect(page.getByText("Нужно согласие на обработку")).toBeVisible();
  });

  test("успех: отправляет ожидаемый JSON и показывает подтверждение", async ({ page }) => {
    let body: Record<string, unknown> | null = null;
    await page.route(ENDPOINT, async (route: Route) => {
      body = route.request().postDataJSON();
      await route.fulfill({ status: 201, contentType: "application/json", body: "{}" });
    });
    await page.goto("/#pilot");
    await fill(page);
    await page.getByLabel(/Даю согласие/).check();
    await page.getByRole("button", { name: "Отправить заявку" }).click();
    await expect(page.getByRole("heading", { name: "Заявка отправлена" })).toBeVisible();
    expect(body).toEqual({ business_name: "Автосервис Пример", city: "Казань", contact_name: "Иван", phone: "+79000000000", email: null, consent: true, website: "" });
  });

  test("защита от двойной отправки: один запрос при двойном клике", async ({ page }) => {
    let calls = 0;
    await page.route(ENDPOINT, async (route) => {
      calls++;
      await new Promise((r) => setTimeout(r, 600));
      await route.fulfill({ status: 201, body: "{}" });
    });
    await page.goto("/#pilot");
    await fill(page, { phone: "", email: "ivan@example.com" });
    await page.getByLabel(/Даю согласие/).check();
    const btn = page.getByRole("button", { name: "Отправить заявку" });
    await btn.dblclick();
    await expect(page.getByRole("heading", { name: "Заявка отправлена" })).toBeVisible();
    expect(calls).toBe(1);
  });

  for (const status of [404, 501]) {
    test(`ответ ${status}: «заявки временно не принимаются» с контактом, данные сохранены`, async ({ page }) => {
      await page.route(ENDPOINT, (route) => route.fulfill({ status, body: "{}" }));
      await page.goto("/#pilot");
      await fill(page);
      await page.getByLabel(/Даю согласие/).check();
      await page.getByRole("button", { name: "Отправить заявку" }).click();
      const alert = page.getByTestId("pilot-error");
      await expect(alert).toContainText("временно не принимаются");
      await expect(alert.getByRole("link")).toHaveAttribute("href", /^mailto:/);
      await expect(page.getByLabel("Город")).toHaveValue("Казань");
      await expect(page.getByRole("button", { name: "Отправить заявку" })).toBeEnabled();
    });
  }

  test("сеть недоступна: понятная ошибка и повтор", async ({ page }) => {
    await page.route(ENDPOINT, (route) => route.abort("failed"));
    await page.goto("/#pilot");
    await fill(page);
    await page.getByLabel(/Даю согласие/).check();
    await page.getByRole("button", { name: "Отправить заявку" }).click();
    await expect(page.getByTestId("pilot-error")).toContainText("Нет связи");
  });

  test("honeypot: заполненное скрытое поле не отправляет запрос", async ({ page }) => {
    let calls = 0;
    await page.route(ENDPOINT, (route) => {
      calls++;
      return route.fulfill({ status: 201, body: "{}" });
    });
    await page.goto("/#pilot");
    await fill(page);
    await page.getByLabel(/Даю согласие/).check();
    await page.locator("#pf-website").evaluate((el: HTMLInputElement) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(el, "http://spam.example");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.getByRole("button", { name: "Отправить заявку" }).click();
    await expect(page.getByRole("heading", { name: "Заявка отправлена" })).toBeVisible();
    expect(calls).toBe(0);
  });
});
