/** Реальный FastAPI + SQLite. Подставлена только доставка почты; код тестового почтовика 123456. */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function connect(page: Page) {
  await page.route("**/api/v1/autoflow/**", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      response: await route.fetch({
        url: `http://127.0.0.1:3311${url.pathname}${url.search}`,
      }),
    });
  });
}
async function login(page: Page, email = "admin@example.com") {
  await page.goto("/login");
  await page.getByLabel("Электронная почта").fill(email);
  await page.getByRole("button", { name: "Получить код", exact: true }).click();
  await page.getByLabel("Код из письма").fill("123456");
  await page
    .getByRole("button", { name: "Войти в AutoFlow", exact: true })
    .click();
  await page.waitForURL("**/app");
}
async function nav(page: Page, path: string) {
  await page
    .locator(`nav[aria-label="Навигация приложения"] a[href="${path}"]`)
    .click();
  await page.waitForURL(`**${path}`);
  const heading = path.endsWith("pilots")
    ? "Заявки на пилот"
    : path.endsWith("services")
      ? "Услуги автосервиса"
      : path.endsWith("resources")
        ? "Боксы и мастера"
        : path.endsWith("settings")
          ? "Ваш автосервис"
          : "Всё по расписанию.";
  await expect(
    page.getByRole("heading", { level: 1, name: heading, exact: true }),
  ).toBeVisible();
}
const tomorrow = () => {
  const date = new Date(Date.now() + 86400000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
};

test("регистрация сохраняется в БД, но новый аккаунт не открывает проект", async ({
  page,
  request,
}, info) => {
  await connect(page);
  const email = `pilot-${info.project.name}-${Date.now()}@example.com`;
  await page.goto("/register");
  await page.getByLabel("Ваше имя").fill("Иван");
  await page.getByLabel("Название автосервиса").fill("Сервис Тест");
  await page.getByLabel("Город").fill("Казань");
  await page.getByLabel("Электронная почта").fill(email);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Получить код", exact: true }).click();
  await page.getByLabel("Код из письма").fill("123456");
  await page
    .getByRole("button", { name: "Завершить регистрацию", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Вы в списке ожидания" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Вы в списке ожидания" }),
  ).toBeVisible();
  const cookies = (await page.context().cookies())
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  const profile = await request.get(
    "http://127.0.0.1:3311/api/v1/autoflow/account",
    { headers: { Cookie: cookies } },
  );
  expect((await profile.json()).profile.business_name).toBe("Сервис Тест");
  expect(
    (
      await request.get(
        `http://127.0.0.1:3311/api/v1/autoflow/app/state?day=${tomorrow()}`,
        { headers: { Cookie: cookies } },
      )
    ).status(),
  ).toBe(403);
  await page.goto("/app/services");
  await expect(
    page.getByRole("heading", { name: "Вы в списке ожидания" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("администратор: вход → настройки → услуги и боксы → настоящая запись → конфликт → статус", async ({
  page,
}, info) => {
  await connect(page);
  await login(page);
  const suffix = `${info.project.name}-${Date.now()}`;
  await page.goto("/app/settings");
  await page.getByLabel("Название автосервиса").fill("Север Авто");
  await page.getByLabel("Город").fill("Казань");
  await page.getByRole("button", { name: "Сохранить автосервис" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /Настройки сохранены|Автосервис создан/ }),
  ).toBeVisible();
  await nav(page, "/app/services");
  await page
    .getByLabel("Название", { exact: true })
    .fill(`Диагностика ${suffix}`);
  await page.getByLabel("Продолжительность, минут").fill("60");
  await page.getByLabel("Стоимость, ₽").fill("1500");
  await page
    .getByRole("button", { name: "Добавить услугу", exact: true })
    .click();
  await expect(
    page.getByText(`Диагностика ${suffix}`, { exact: true }),
  ).toBeVisible();
  await nav(page, "/app/resources");
  await page.getByLabel("Название", { exact: true }).fill(`Бокс ${suffix}`);
  await page
    .getByRole("button", { name: "Добавить бокс", exact: true })
    .click();
  await expect(page.getByText(`Бокс ${suffix}`, { exact: true })).toBeVisible();
  await nav(page, "/app");
  await page.getByLabel("Дата", { exact: true }).fill(tomorrow());
  await page.getByRole("button", { name: "Новая запись", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Новая запись" });
  async function fill(time: string) {
    await dialog
      .getByLabel("Услуга", { exact: true })
      .selectOption({ label: `Диагностика ${suffix} · 60 мин` });
    await dialog
      .getByLabel("Бокс или мастер")
      .selectOption({ label: `Бокс ${suffix}` });
    await dialog.getByLabel("Время", { exact: true }).fill(time);
    await dialog.getByLabel("Имя клиента").fill(`Клиент ${suffix}`);
    await dialog.getByLabel("Телефон клиента").fill("+79991234567");
    await dialog.getByRole("checkbox").check();
  }
  await fill("10:00");
  await dialog
    .getByRole("button", { name: "Создать запись", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  const row = page
    .locator(".booking-row")
    .filter({ hasText: `Клиент ${suffix}` });
  await expect(row).toContainText("10:00");
  await page.reload();
  await page.getByLabel("Дата", { exact: true }).fill(tomorrow());
  await expect(row).toBeVisible();
  await page.getByRole("button", { name: "Новая запись", exact: true }).click();
  await fill("10:30");
  await dialog
    .getByRole("button", { name: "Создать запись", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("Это время уже занято");
  await expect(dialog.getByLabel("Имя клиента")).toHaveValue(
    `Клиент ${suffix}`,
  );
  if (info.project.name === "desktop") {
    await page.keyboard.press("Tab");
    expect(
      await dialog.evaluate((el) => el.contains(document.activeElement)),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Новая запись", exact: true }),
    ).toBeFocused();
  } else
    await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  await row.getByRole("combobox").selectOption("confirmed");
  await expect(row.getByRole("combobox")).toHaveValue("confirmed");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("application.png"),
    fullPage: true,
  });
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  const leadName = `Пилот ${suffix}`;
  const lead = await page.request.post(
    "http://127.0.0.1:3311/api/v1/autoflow/pilot-requests",
    {
      headers: { Origin: "http://localhost:3300" },
      data: {
        business_name: leadName,
        city: "Казань",
        contact_name: "Иван",
        email: `lead-${suffix}@example.com`,
        consent: true,
      },
    },
  );
  expect(lead.status()).toBe(202);
  await nav(page, "/app/pilots");
  const leadCard = page.locator(".pilot-card").filter({ hasText: leadName });
  await leadCard.getByRole("button", { name: "Открыть", exact: true }).click();
  const edit = page.getByRole("dialog", { name: leadName, exact: true });
  await edit.getByLabel("Статус заявки").selectOption("contacted");
  await edit
    .getByLabel("Заметка", { exact: true })
    .fill("Договорились о пилоте");
  await edit
    .getByRole("button", { name: "Сохранить заявку", exact: true })
    .click();
  await expect(edit).toHaveCount(0);
  await expect(leadCard).toContainText("Связались");
});

test("без сессии кабинет ведёт ко входу; приватные маршруты не индексируются", async ({
  page,
  request,
}) => {
  await connect(page);
  await page.goto("/app");
  await expect(page).toHaveURL(/\/login$/);
  const response = await request.get("/app");
  expect(response.headers()["x-robots-tag"]).toContain("noindex");
  expect(await (await request.get("/robots.txt")).text()).toContain(
    "Disallow: /app",
  );
});

test("лендинг помещается на экране, показывает продукт и поддерживает reduced motion", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByRole("link", { name: "Войти", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: /Расписание AutoFlow/ }),
  ).toBeVisible();
  await expect(page.locator(".product-preview figcaption")).toContainText(
    "данные для примера",
  );
  const duration = await page
    .locator(".hero-copy")
    .evaluate((el) => getComputedStyle(el).animationDuration);
  expect(duration).toBe("0s");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath("landing.png") });
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
});

for (const path of ["/login", "/register"])
  test(`доступность и вёрстка ${path}`, async ({ page }, info) => {
    await page.goto(path);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(path.slice(1) + ".png"),
      fullPage: true,
    });
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
  });
