import { expect, test, type Page } from "@playwright/test";
import { CSRF, installFakeServer, toCp1251, type FakeOptions, type FakeServer } from "./fake-server";

/** Тесты рабочей сборки (NEXT_PUBLIC_AUTH_MODE=live, NEXT_PUBLIC_DATA_MODE=live): сеть подменена ответами формата реального сервера. */

async function start(page: Page, baseURL: string | undefined, opts: FakeOptions = {}): Promise<FakeServer> {
  return installFakeServer(page, baseURL!, { loggedIn: true, ...opts });
}
const noScroll = async (page: Page) => {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over, "горизонтальный скролл").toBeLessThanOrEqual(0);
};
const importFile = (page: Page, name: string, buffer: Buffer | string) =>
  page.locator('input[type="file"]').setInputFiles({ name, mimeType: "text/csv", buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer, "utf-8") });
const rowsLoc = (page: Page) => page.locator("a.cell-name");

test.describe("вход и пустая база", () => {
  test("вход по коду, пустая база предлагает загрузить CSV, демо-меток нет", async ({ page, baseURL }) => {
    const server = await start(page, baseURL, { loggedIn: false });
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(/Демо|123456/)).toHaveCount(0);
    await page.getByLabel("Email").fill("owner@example.com");
    await page.getByRole("button", { name: "Получить код" }).click();
    await page.getByLabel("Цифра 1 из 6").waitFor();
    await expect(page.getByText(/Демо|123456/)).toHaveCount(0);
    await page.keyboard.type("123456");
    await page.waitForURL("**/overview");
    await expect(page.getByRole("heading", { level: 2, name: "Загрузите свой CSV" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Импортировать CSV" })).toBeVisible();
    await expect(page.getByText(/Демо/)).toHaveCount(0);
    expect(server.called("POST", "/auth/otp/verify")).toHaveLength(1);
    // Счётчиков нет: данных нет, нули-заглушки не рисуются.
    await expect(page.locator(".nav-count")).toHaveCount(0);
  });

  test("без сессии защищённая страница ведёт на /login", async ({ page, baseURL }) => {
    await start(page, baseURL, { loggedIn: false });
    await page.goto("/companies");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("база компаний пуста: EmptyState с кнопкой импорта", async ({ page, baseURL }) => {
    await start(page, baseURL);
    await page.goto("/companies");
    await expect(page.getByRole("heading", { name: "Загрузите свой CSV" })).toBeVisible();
    await page.getByRole("button", { name: "Импорт CSV" }).last().click();
    await expect(page.getByRole("dialog", { name: "Импорт компаний из CSV" })).toBeVisible();
  });
});

test.describe("импорт CSV", () => {
  const csv = "название;город;категория;сайт\nСевер Авто;Казань;Автосервис;sever-auto.ru\nЮг Сервис;Уфа;СТО;\n;Тверь;СТО;\nСевер Авто;Казань;Автосервис;\n";

  test("пустая база → dry-run → импорт → список; сервер получает текст файла и CSRF", async ({ page, baseURL }) => {
    const server = await start(page, baseURL);
    await page.goto("/companies");
    await page.getByRole("button", { name: "Импорт CSV" }).last().click();
    await importFile(page, "companies.csv", csv);
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByText("Предпросмотр (dry-run)")).toBeVisible();
    // Итоги — из ответа сервера: 4 строки, 2 к импорту, 1 дубль в файле, 1 с ошибкой.
    const sums = dlg.locator("div").filter({ hasText: /^\d+(строк всего|к импорту|точные дубли|возможные дубли|с ошибками)$/ });
    await expect(sums.filter({ hasText: "строк всего" })).toContainText("4");
    await expect(sums.filter({ hasText: "к импорту" })).toContainText("2");
    await expect(sums.filter({ hasText: "точные дубли" })).toContainText("1");
    await expect(sums.filter({ hasText: "с ошибками" })).toContainText("1");
    await expect(dlg.getByText("Нет названия")).toBeVisible();
    await expect(dlg.getByText("Дубль в файле: Север Авто")).toBeVisible();
    // Пока не нажали «Импортировать», в базе ничего нет.
    expect(server.companies).toHaveLength(0);
    await dlg.getByRole("button", { name: "Импортировать 2" }).click();
    await expect(dlg.getByRole("status")).toContainText("Добавлено компаний: 2. Пропущено: 2.");
    await dlg.getByRole("link", { name: "Открыть базу компаний" }).click();
    await expect(rowsLoc(page)).toHaveCount(2);
    await expect(page.getByRole("link", { name: "Север Авто", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Юг Сервис", exact: true })).toBeVisible();

    const calls = server.called("POST", "/imports/companies");
    expect(calls.map((c) => c.query.get("dry_run"))).toEqual(["true", "false"]);
    expect(calls[0]!.body).toBe(csv);
    expect(calls[1]!.body).toBe(csv);
    for (const c of calls) {
      expect(c.headers["x-csrf-token"]).toBe(CSRF);
      expect(c.headers["content-type"]).toContain("text/csv");
    }
  });

  test("файл в кодировке Windows-1251 читается", async ({ page, baseURL }) => {
    const server = await start(page, baseURL);
    await page.goto("/companies");
    await page.getByRole("button", { name: "Импорт CSV" }).last().click();
    await importFile(page, "excel.csv", toCp1251("название;город\nЁлка Сервис;Тверь\n"));
    await expect(page.getByRole("dialog").getByText("Ёлка Сервис")).toBeVisible();
    expect(server.called("POST", "/imports/companies")[0]!.body).toContain("Ёлка Сервис");
  });

  test("нет обязательных колонок и ошибки сервера показываются русскими текстами", async ({ page, baseURL }) => {
    await start(page, baseURL, { failNext: { "POST /imports/companies": { status: 422, body: { code: "TOO_MANY_ROWS", message: "Too many", request_id: "r" } } } });
    await page.goto("/companies");
    await page.getByRole("button", { name: "Импорт CSV" }).last().click();
    await importFile(page, "big.csv", "название;город\nА;Б\n");
    await expect(page.getByRole("alert").filter({ hasText: "Максимум 5000 строк" })).toBeVisible();
    await importFile(page, "bad.csv", "имя;адрес\nА;Б\n");
    await expect(page.getByRole("alert").filter({ hasText: "нет обязательных колонок: название, город" })).toBeVisible();
    await importFile(page, "empty.csv", "название;город\n");
    await expect(page.getByRole("alert").filter({ hasText: "В файле нет строк с данными" })).toBeVisible();
    await importFile(page, "table.xlsx", "x");
    await expect(page.getByRole("alert").filter({ hasText: "XLSX" })).toBeVisible();
  });

  test("после импорта счётчик в меню и обзор показывают реальные числа", async ({ page, baseURL, isMobile }) => {
    await start(page, baseURL);
    await page.goto("/companies");
    await page.getByRole("button", { name: "Импорт CSV" }).last().click();
    await importFile(page, "c.csv", "название;город\nАльфа;Казань\nБета;Уфа\n");
    await page.getByRole("dialog").getByRole("button", { name: "Импортировать 2" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Закрыть" }).click();
    await page.goto("/overview");
    await expect(page.getByText("Компании в базе")).toBeVisible();
    await expect(page.locator(".metric-value").first()).toHaveText("2");
    if (isMobile) await page.getByRole("button", { name: "Открыть меню" }).click();
    await expect(page.getByRole("navigation").getByRole("link", { name: /База компаний/ }).locator(".nav-count")).toHaveText("2");
    // Раздел «Согласование»/«Диалоги» не показывают выдуманных счётчиков.
    await expect(page.getByRole("navigation").getByRole("link", { name: /Согласование/ }).locator(".nav-count")).toHaveCount(0);
  });
});

test.describe("список, фильтры, экспорт", () => {
  test("«Показать ещё» идёт по cursor без повторов", async ({ page, baseURL }) => {
    const server = await start(page, baseURL, { companies: 120 });
    await page.goto("/companies");
    await expect(rowsLoc(page)).toHaveCount(50);
    await page.getByRole("button", { name: "Показать ещё" }).click();
    await expect(rowsLoc(page)).toHaveCount(100);
    await page.getByRole("button", { name: "Показать ещё" }).click();
    await expect(rowsLoc(page)).toHaveCount(120);
    await expect(page.getByRole("button", { name: "Показать ещё" })).toHaveCount(0);
    const names = await rowsLoc(page).allTextContents();
    expect(new Set(names).size).toBe(120);
    const list = server.called("GET", "/companies").filter((r) => r.path === "/companies");
    expect(list[0]!.query.get("cursor")).toBeNull();
    expect(list[1]!.query.get("cursor")).toBeTruthy();
    expect(list.every((r) => r.query.get("limit") === "50")).toBe(true);
  });

  test("поиск и город уходят на сервер параметрами", async ({ page, baseURL }) => {
    const server = await start(page, baseURL, { companies: [{ name: "Север Авто", city: "Казань" }, { name: "Юг Сервис", city: "Уфа" }] });
    await page.goto("/companies");
    await expect(rowsLoc(page)).toHaveCount(2);
    await page.getByLabel("Поиск по компаниям").fill("север");
    await expect(rowsLoc(page)).toHaveCount(1);
    await page.getByLabel("Поиск по компаниям").fill("");
    await page.getByLabel("Город").selectOption("Уфа");
    await expect(rowsLoc(page)).toHaveCount(1);
    await expect(page.getByRole("link", { name: "Юг Сервис", exact: true })).toBeVisible();
    const qs = server.called("GET", "/companies").map((r) => [r.query.get("query"), r.query.get("city")]);
    expect(qs).toContainEqual(["север", null]);
    expect(qs).toContainEqual([null, "Уфа"]);
  });

  test("экспорт CSV скачивает файл с BOM", async ({ page, baseURL }) => {
    await start(page, baseURL, { companies: [{ name: "Север Авто", city: "Казань" }] });
    await page.goto("/companies");
    await expect(rowsLoc(page)).toHaveCount(1);
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Экспорт CSV" }).click()]);
    expect(dl.suggestedFilename()).toBe("leadhunter-companies.csv");
    const body = (await import("node:fs")).readFileSync((await dl.path())!);
    expect(body.subarray(0, 3).toString("hex")).toBe("efbbbf");
    expect(body.toString("utf-8")).toContain("Север Авто");
  });

  test("ошибка сервера: состояние ошибки и повтор", async ({ page, baseURL }) => {
    await start(page, baseURL, { companies: [{ name: "Север Авто", city: "Казань" }], failNext: { "GET /companies": { status: 500, body: { code: "INTERNAL_ERROR", message: "boom", request_id: "r" } } } });
    await page.goto("/companies");
    await expect(page.getByRole("alert").filter({ hasText: "Внутренняя ошибка сервера" })).toBeVisible();
    await page.getByRole("button", { name: "Повторить" }).click();
    await expect(rowsLoc(page)).toHaveCount(1);
  });
});

test.describe("карточка и стадии", () => {
  const seed = { companies: [{ name: "Север Авто", city: "Казань", website: "https://sever-auto.ru", domain: "sever-auto.ru" }] };

  test("карточка: оценка, история, заметка; недоступное отключено с пояснением", async ({ page, baseURL }) => {
    const server = await start(page, baseURL, seed);
    await page.goto("/companies");
    await page.getByRole("link", { name: "Север Авто", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Север Авто" })).toBeVisible();
    await expect(page.getByText("Тип бизнеса")).toBeVisible();
    await expect(page.getByText("Импортирована из CSV")).toBeVisible();
    await expect(page.getByTestId("contacts-soon")).toContainText("появятся в следующем обновлении");
    const draft = page.getByRole("button", { name: "Создать черновик" });
    await expect(draft).toBeDisabled();
    await expect(draft).toHaveAttribute("title", /следующем обновлении/);
    await expect(page.getByRole("button", { name: "Создать задачу" })).toBeDisabled();
    await page.getByLabel("Заметка").fill("Позвонить в понедельник");
    await page.getByRole("button", { name: "Сохранить заметку" }).click();
    await expect(page.getByText("Заметка сохранена")).toBeVisible();
    expect(server.find("Север Авто").note).toBe("Позвонить в понедельник");
    const patch = server.called("PATCH", "/companies/")[0]!;
    expect(JSON.parse(patch.body!)).toEqual({ note: "Позвонить в понедельник" });
    expect(patch.headers["x-csrf-token"]).toBe(CSRF);
    await noScroll(page);
  });

  test("смена стадии отправляет expected_stage", async ({ page, baseURL }) => {
    const server = await start(page, baseURL, seed);
    await page.goto("/companies");
    await page.getByRole("link", { name: "Север Авто", exact: true }).click();
    await page.getByLabel("Стадия воронки").selectOption("contacted");
    await expect(page.getByText("Стадия обновлена")).toBeVisible();
    expect(JSON.parse(server.called("PATCH", "/companies/")[0]!.body!)).toEqual({ stage: "contacted", expected_stage: "new" });
    expect(server.find("Север Авто").stage).toBe("contacted");
  });

  test("409 STAGE_CONFLICT: понятное сообщение и обновление карточки", async ({ page, baseURL }) => {
    const server = await start(page, baseURL, seed);
    await page.goto("/companies");
    await page.getByRole("link", { name: "Север Авто", exact: true }).click();
    const select = page.getByLabel("Стадия воронки");
    await expect(select).toHaveValue("new");
    server.setStageBehind("Север Авто", "replied"); // другой пользователь сменил стадию
    await select.selectOption("pilot");
    await expect(page.getByText(/Стадию уже изменили в другом месте/)).toBeVisible();
    await expect(select).toHaveValue("replied"); // карточка перечитана с сервера
    expect(server.find("Север Авто").stage).toBe("replied");
  });

  test("воронка: колонки по stage, 409 при перемещении", async ({ page, baseURL }) => {
    const server = await start(page, baseURL, { companies: [{ name: "Север Авто", city: "Казань" }, { name: "Юг Сервис", city: "Уфа", stage: "contacted" }] });
    await page.goto("/pipeline");
    await expect(page.getByLabel("Стадия: Север Авто")).toHaveValue("new");
    await expect(page.getByLabel("Стадия: Юг Сервис")).toHaveValue("contacted");
    server.setStageBehind("Север Авто", "interested");
    await page.getByLabel("Стадия: Север Авто").selectOption("pilot");
    await expect(page.getByText(/Стадию уже изменили в другом месте/)).toBeVisible();
    await expect(page.getByLabel("Стадия: Север Авто")).toHaveValue("interested");
    await page.getByLabel("Стадия: Юг Сервис").selectOption("pilot");
    await expect(page.getByLabel("Стадия: Юг Сервис")).toHaveValue("pilot");
    expect(server.find("Юг Сервис").stage).toBe("pilot");
  });

  test("отказ нельзя вернуть: SUPPRESSION_PERMANENT", async ({ page, baseURL }) => {
    await start(page, baseURL, { companies: [{ name: "Север Авто", city: "Казань", stage: "lost" }] });
    await page.goto("/pipeline");
    await page.getByLabel("Стадия: Север Авто").selectOption("new");
    await expect(page.getByText(/У компании есть отказ/)).toBeVisible();
  });
});

test.describe("разделы «скоро» и честные статусы", () => {
  const seed = { companies: [{ name: "Север Авто", city: "Казань" }] };

  for (const [path, h1] of [["/approvals", "Согласование"], ["/inbox", "Центр сообщений"]] as const) {
    test(`${path}: «Раздел появится в следующем обновлении», без демо-данных и кнопок-пустышек`, async ({ page, baseURL }) => {
      const server = await start(page, baseURL, seed);
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1, name: h1 })).toBeVisible();
      await expect(page.getByTestId("coming-soon")).toContainText("Раздел появится в следующем обновлении");
      await expect(page.getByTestId("coming-soon").getByRole("button")).toHaveCount(0);
      await expect(page.locator("main").getByText(/Демо|Пятый бокс|МоторЛайн|Северный мотор|123456/)).toHaveCount(0);
      expect(server.requests.filter((r) => /drafts|conversations|outbox/.test(r.path))).toHaveLength(0);
      await noScroll(page);
    });
  }

  test("поиск компаний: импорт работает, кампании/очередь/источники — «скоро»", async ({ page, baseURL }) => {
    await start(page, baseURL, seed);
    await page.goto("/discovery");
    await expect(page.getByRole("button", { name: "Импорт CSV" }).first()).toBeVisible();
    await expect(page.getByTestId("coming-soon")).toHaveCount(3);
    await expect(page.getByRole("heading", { name: "Кампании появятся в следующем обновлении" })).toBeVisible();
    await expect(page.locator("main").getByText(/Демо|Пятый бокс|123456/)).toHaveCount(0);
    await page.getByRole("button", { name: "Выбрать CSV" }).click();
    await expect(page.getByRole("dialog", { name: "Импорт компаний из CSV" })).toBeVisible();
  });

  test("аналитика: только счётчики по стадиям, остальное «скоро»", async ({ page, baseURL }) => {
    await start(page, baseURL, { companies: [{ name: "А", city: "К" }, { name: "Б", city: "К", stage: "contacted" }, { name: "В", city: "К", stage: "contacted" }] });
    await page.goto("/analytics");
    await expect(page.getByText("Компании по стадиям")).toBeVisible();
    const contacted = page.locator("li", { hasText: /^Контакт/ });
    await expect(contacted).toContainText("2");
    await expect(page.getByTestId("coming-soon")).toContainText("появятся в следующем обновлении");
    await expect(page.getByRole("heading", { name: "Качество базы", exact: true })).toHaveCount(0);
    await expect(page.getByText(/Демо/)).toHaveCount(0);
    await noScroll(page);
  });

  test("настройки: открыта «Пользователи», остальные вкладки «скоро»", async ({ page, baseURL }) => {
    await start(page, baseURL, seed);
    await page.goto("/settings");
    await expect(page.getByRole("tab", { name: "Пользователи" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { level: 2, name: "Пользователи" })).toBeVisible();
    for (const tab of ["AI", "Каналы", "Безопасность и отправка", "Подавление", "Журнал аудита", "Резервные копии"]) {
      await page.getByRole("tab", { name: tab }).click();
      await expect(page.getByTestId("coming-soon")).toContainText("Раздел появится в следующем обновлении");
      await expect(page.getByTestId("coming-soon").getByRole("button")).toHaveCount(0);
    }
  });

  test("боковое меню: реальные статусы вместо демо", async ({ page, baseURL, isMobile }) => {
    await start(page, baseURL, seed);
    await page.goto("/overview");
    await expect(page.getByText("Демо-данные")).toHaveCount(0);
    if (isMobile) await page.getByRole("button", { name: "Открыть меню" }).click();
    const card = page.locator(".mode-card");
    await expect(card).toContainText("Рабочие");
    await expect(card).not.toContainText("Демо");
    await expect(card).not.toContainText("Без AI");
  });

  test("все страницы без горизонтальной прокрутки", async ({ page, baseURL }) => {
    await start(page, baseURL, { companies: 5 });
    for (const r of ["overview", "discovery", "companies", "approvals", "inbox", "pipeline", "analytics", "settings"]) {
      await page.goto("/" + r);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await noScroll(page);
    }
  });
});
