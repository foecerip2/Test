import { expect, test, type Page } from "@playwright/test";
import { CSRF, installFakeServer } from "./fake-server";

const PATH = "/api/v1/autoflow/pilot-requests";
const sample = (n: number) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, business_name: `Авто ${n}`, city: "Казань", contact_name: "Иван",
  phone: "+79991234567", email: "owner@auto.test", status: "new", note: "", consent_text_version: "v1",
  consent_at: "2026-11-11T12:00:00Z", created_at: "2026-11-11T12:00:00Z", updated_at: "2026-11-11T12:00:00Z",
});

async function setup(page: Page, baseURL: string, count = 1) {
  await installFakeServer(page, baseURL, { loggedIn: true });
  const rows = Array.from({ length: count }, (_, i) => sample(i + 1));
  const patches: Array<{ headers: Record<string, string>; body: Record<string, string> }> = [];
  let failPatch = false;
  let failList = false;
  await page.context().route(`**${PATH}**`, async (route) => {
    const req = route.request(), url = new URL(req.url());
    const json = (status: number, data: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    if (req.method() === "PATCH") {
      patches.push({ headers: req.headers(), body: req.postDataJSON() as Record<string, string> });
      if (failPatch) return json(503, { code: "INTERNAL_ERROR" });
      const row = rows.find((r) => url.pathname.endsWith(r.id))!;
      Object.assign(row, req.postDataJSON());
      return json(200, row);
    }
    if (failList) { failList = false; return json(503, { code: "INTERNAL_ERROR" }); }
    const status = url.searchParams.get("status");
    const filtered = rows.filter((r) => !status || r.status === status);
    const offset = Number(url.searchParams.get("cursor") ?? 0);
    // Маленькая серверная страница для проверки непрозрачной курсорной навигации.
    return json(200, { items: filtered.slice(offset, offset + 2), next_cursor: offset + 2 < filtered.length ? String(offset + 2) : null });
  });
  await page.context().route("**/api/v1/dashboard", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    companies_total: 0, companies_week: 0, suitable: 0, recent: [], top_companies: [], pilot_requests_new: rows.filter((r) => r.status === "new").length,
  }) }));
  return { rows, patches, failPatch: () => { failPatch = true; }, failList: () => { failList = true; } };
}

test("владелец видит заявки, сохраняет статус и заметку, обновляется счётчик", async ({ page, baseURL }) => {
  const server = await setup(page, baseURL!);
  await page.goto("/autoflow/pilots");
  await page.getByRole("button", { name: "Открыть заявку: Авто 1", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Авто 1", exact: true });
  await expect(dialog).toContainText("+79991234567");
  await dialog.getByLabel("Статус заявки").selectOption("contacted");
  await dialog.getByLabel("Заметка владельца").fill("Обсудили пилот, ждём подтверждения");
  await dialog.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Заявки на пилот" })).toContainText("Связались");
  expect(server.patches[0]!.headers["x-csrf-token"]).toBe(CSRF);
  expect(server.rows[0]!.note).toBe("Обсудили пилот, ждём подтверждения");
  await expect(page.locator('a[href="/autoflow/pilots"] .nav-count')).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "Открыть заявку: Авто 1", exact: true }).click();
  await expect(page.getByLabel("Заметка владельца")).toHaveValue("Обсудили пилот, ждём подтверждения");
});

test("фильтр и страницы запрашиваются у сервера, фильтр сбрасывает курсор", async ({ page, baseURL }) => {
  const server = await setup(page, baseURL!, 3);
  server.rows[2]!.status = "accepted";
  await page.goto("/autoflow/pilots");
  await page.getByRole("button", { name: "Далее", exact: true }).click();
  await expect(page.getByRole("button", { name: "Открыть заявку: Авто 3", exact: true })).toBeVisible();
  await page.getByLabel("Статус", { exact: true }).selectOption("new");
  await expect(page.getByRole("button", { name: "Открыть заявку: Авто 1", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Назад", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Далее", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("ошибка сохранения не закрывает окно и не теряет введённую заметку", async ({ page, baseURL }) => {
  const server = await setup(page, baseURL!);
  server.failPatch();
  await page.goto("/autoflow/pilots");
  await page.getByRole("button", { name: "Открыть заявку: Авто 1", exact: true }).click();
  await page.getByLabel("Заметка владельца").fill("Не терять эту заметку");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("Заметка владельца")).toHaveValue("Не терять эту заметку");
  expect(server.rows[0]!.note).toBe("");
});

test("ошибка списка допускает повторный запрос, пустой список показан честно", async ({ page, baseURL }) => {
  const server = await setup(page, baseURL!, 0);
  server.failList();
  await page.goto("/autoflow/pilots");
  await expect(page.getByRole("heading", { name: "Не удалось загрузить данные" })).toBeVisible();
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Заявок пока нет" })).toBeVisible();
});

test("обычный пользователь не видит раздел и не запрашивает персональные данные", async ({ page, baseURL }) => {
  const server = await installFakeServer(page, baseURL!, { loggedIn: true, role: "user" });
  await page.goto("/autoflow/pilots");
  await expect(page.getByRole("heading", { name: "Нет доступа" })).toBeVisible();
  await expect(page.locator('a[href="/autoflow/pilots"]')).toHaveCount(0);
  expect(server.called("GET", "/autoflow/pilot-requests")).toHaveLength(0);
});

test("новая заявка видна в обзоре даже без компаний LeadHunter", async ({ page, baseURL }) => {
  await setup(page, baseURL!);
  await page.goto("/overview");
  await expect(page.getByRole("heading", { name: "Новые заявки AutoFlow: 1" })).toBeVisible();
  await page.getByRole("link", { name: "Открыть заявки" }).click();
  await expect(page).toHaveURL(/\/autoflow\/pilots$/);
  await expect(page.getByRole("button", { name: "Открыть заявку: Авто 1", exact: true })).toBeVisible();
});
