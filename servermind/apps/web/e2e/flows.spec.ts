import { expect, test, type Page } from "@playwright/test";
import { settle } from "./helpers";

async function storageDump(page: Page) {
  return page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie }));
}

test("вход: валидация, 2FA, переход на dashboard", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByText("Введите корректный email.")).toBeVisible();
  await expect(page.getByText("Пароль — не короче 8 символов.")).toBeVisible();
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByLabel("Пароль", { exact: true }).fill("longenough1");
  await page.getByRole("button", { name: "Показать значение" }).click(); // show-password
  await expect(page.getByLabel("Пароль", { exact: true })).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Код подтверждения" })).toBeVisible();
  const code = page.getByRole("textbox", { name: "Код" });
  await code.fill("12");
  await page.getByRole("button", { name: "Подтвердить" }).click();
  await expect(page.getByText("Код состоит из 6 цифр.")).toBeVisible();
  await code.fill("123456");
  await page.getByRole("button", { name: "Подтвердить" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
});

test("добавление сервера: SSRF-политика, root, ошибки DNS/порта, подмена отпечатка, успех", async ({ page }) => {
  await page.goto("/servers/new");
  await settle(page);
  const host = page.getByLabel("IP-адрес или домен");
  const probe = page.getByRole("button", { name: "Получить отпечаток сервера" });
  // отсутствует поле пароля root
  await expect(page.getByLabel(/пароль/i)).toHaveCount(0);

  await host.fill("10.0.0.5"); await probe.click();
  await expect(page.getByText("Приватные, loopback и link-local адреса запрещены")).toBeVisible();
  await host.fill("203.0.113.50"); await page.getByLabel("Пользователь").fill("root"); await probe.click();
  await expect(page.getByText("Подтвердите риск входа под root")).toBeVisible(); // без явного согласия root не пропускается
  await expect(page.getByText("полный доступ root").first()).toBeVisible();
  await page.getByRole("checkbox", { name: /Понимаю риск/ }).click();
  await expect(page.getByText("Подтвердите риск входа под root")).toHaveCount(0);
  await page.getByLabel("Пользователь").fill("servermind");
  await expect(page.getByRole("checkbox", { name: /Понимаю риск/ })).toHaveCount(0); // у обычного пользователя предупреждения нет

  await host.fill("host.invalid"); await probe.click();
  await expect(page.getByText("Не удалось разрешить DNS-имя")).toBeVisible();
  await host.fill("203.0.113.50"); await page.getByLabel("Порт SSH").fill("9"); await probe.click();
  await expect(page.getByText(/Соединение с .* отклонено/)).toBeVisible();
  await page.getByLabel("Порт SSH").fill("22");

  // подмена отпечатка при добавлении блокируется
  await host.fill("mitm.example.com"); await probe.click();
  await page.getByRole("checkbox", { name: /Отпечатки совпадают/ }).click();
  await page.getByRole("button", { name: "Продолжить" }).click();
  await page.getByRole("checkbox", { name: /Я владелец/ }).click();
  await page.getByRole("button", { name: "Проверить и добавить" }).click();
  await expect(page.getByText("Подключение заблокировано: возможна подмена сервера")).toBeVisible();
  await page.getByRole("button", { name: "Назад" }).click();
  await page.getByRole("button", { name: "Назад" }).click();

  // успешный путь
  await page.getByLabel("Название (необязательно)").fill("e2e-server");
  await host.fill("203.0.113.50"); await probe.click();
  await expect(page.getByRole("heading", { name: "2. Сверьте отпечаток сервера" })).toBeVisible();
  const cont = page.getByRole("button", { name: "Продолжить" });
  await expect(cont).toBeDisabled();
  await page.getByRole("checkbox", { name: /Отпечатки совпадают/ }).click();
  await cont.click();
  const add = page.getByRole("button", { name: "Проверить и добавить" });
  await expect(add).toBeDisabled();
  await page.getByRole("checkbox", { name: /Я владелец/ }).click();
  await add.click();
  await expect(page.getByRole("heading", { name: "Сервер подключён" })).toBeVisible();
  await page.getByRole("link", { name: "Открыть сервер" }).click();
  await expect(page.getByRole("heading", { name: /e2e-server/ })).toBeVisible();
});

test("AI: объяснение 502 без мутаций → план в статусе «ждёт подтверждения» → экран подтверждения", async ({ page }) => {
  await page.goto("/assistant?server=srv_demo_web1");
  await settle(page);
  await page.getByLabel("Сообщение ассистенту").fill("Почему сайт отвечает 502?");
  await page.getByLabel("Сообщение ассистенту").press("Enter");
  await expect(page.getByText("Прочитано с сервера")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Демо-ответ: сценарий, не модель")).toBeVisible();
  await expect(page.getByText("План ещё не выполнен")).toBeVisible();
  // только read-only инструменты в таймлайне
  const tools = await page.locator("details ol li p.font-mono").allInnerTexts();
  expect(tools.length).toBeGreaterThanOrEqual(3);
  expect(tools.join(" ")).toMatch(/server\.facts/);
  expect(tools.join(" ")).not.toMatch(/restart|install|deploy/);
  await page.getByRole("link", { name: "Просмотреть план и подтвердить" }).click();
  await expect(page).toHaveURL(/\/operations\/op_plan_.*\/approve/);
  await expect(page.getByText("Ничего не выполняется до вашего подтверждения")).toBeVisible();
});

test("подтверждение: изменение плана сбрасывает подтверждение, диалог требует явный чек, фокус-ловушка, выполнение ровно один раз", async ({ page }) => {
  await page.goto("/operations/op_plan_demo_docker/approve");
  await settle(page);
  const hashEl = page.locator("code[title]").first();
  const h1 = await hashEl.innerText();
  expect(h1).toMatch(/^[0-9a-f]{64}$/);
  await expect(page.getByText("Хеш плана независимо пересчитан в браузере и совпадает")).toBeVisible();

  // изменение плана → новая ревизия и новый хеш
  await page.getByRole("switch", { name: /Включить шаг/ }).click();
  await expect(page.getByText("Ревизия").locator("xpath=following-sibling::dd")).toHaveText("2");
  await expect(hashEl).not.toHaveText(h1);
  await expect(page.getByText("Хеш плана независимо пересчитан в браузере и совпадает")).toBeVisible();

  // диалог: подтвердить нельзя без чекбокса
  await page.getByRole("button", { name: "Подтвердить…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const go = dialog.getByRole("button", { name: "Подтвердить и выполнить" });
  await expect(go).toBeDisabled();
  for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true); // фокус не уходит из диалога
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "Подтвердить…" }).click();
  await dialog.getByRole("checkbox").click();
  await expect(go).toBeEnabled();
  await go.click();
  await expect(page).toHaveURL(/\/operations\/op_plan_demo_docker$/);
  await expect(page.getByText("Выполняется", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Выполнено", { exact: true }).first()).toBeVisible({ timeout: 25_000 });
  const log = await page.getByRole("log").innerText();
  expect(log).toContain("[демо]");
  expect(log).toContain("Реальных изменений на сервере не было");
  // повторное подтверждение уже невозможно (history.back — клиентская навигация, память фикстур сохраняется)
  await page.goBack();
  await expect(page.getByText("План уже подтверждён")).toBeVisible();
  await expect(page.getByRole("button", { name: "Подтвердить…" })).toHaveCount(0);
});

test("деплой: секреты не попадают в хранилище/DOM плана; недоступный сервер блокирует деплой; отклонение плана", async ({ page }) => {
  const SECRET = "SUPERSECRETVALUE123";
  await page.goto("/deploy");
  await settle(page);
  await page.getByRole("button", { name: "Далее" }).click();

  // сервер demo-archive: офлайн и диск 92% → блокировка
  await page.getByLabel("Сервер", { exact: true }).selectOption("srv_demo_archive");
  await page.getByRole("button", { name: "Далее" }).click();
  await page.getByRole("button", { name: "Далее" }).click();
  await page.getByRole("button", { name: "Запустить проверки" }).click();
  await expect(page.getByText("Деплой заблокирован")).toBeVisible();
  await expect(page.getByRole("button", { name: "Создать план" })).toBeDisabled();
  await page.getByRole("button", { name: "Назад" }).click();
  await page.getByRole("button", { name: "Назад" }).click();

  // рабочий сервер
  await page.getByLabel("Сервер", { exact: true }).selectOption("srv_demo_stage");
  await page.getByRole("button", { name: "Далее" }).click();
  await page.getByRole("button", { name: "Добавить переменную" }).click();
  await page.getByLabel("Имя переменной 1").fill("database_url");
  await page.getByLabel("Значение переменной 1").fill(SECRET);
  await page.getByRole("button", { name: "Далее" }).click();
  expect(await storageDump(page)).not.toContain(SECRET);
  await page.getByRole("button", { name: "Запустить проверки" }).click();
  await expect(page.getByRole("button", { name: "Создать план" })).toBeEnabled();
  await page.getByRole("button", { name: "Создать план" }).click();
  await expect(page).toHaveURL(/\/approve/);
  await expect(page.getByText("DATABASE_URL").first()).toBeVisible(); // только имя переменной
  expect(await page.locator("body").innerText()).not.toContain(SECRET);
  expect(await storageDump(page)).not.toContain(SECRET);

  await page.getByRole("button", { name: "Отклонить" }).click();
  await expect(page).toHaveURL(/\/operations\/op_plan_/);
  await expect(page.getByText("Отменено").first()).toBeVisible();
  await expect(page.getByRole("log")).toContainText("План отклонён владельцем");
});

test("BYOK: ключ не попадает в DOM и хранилище, показывается только маска", async ({ page }) => {
  const KEY = "sk-ant-TESTKEYTESTKEY99";
  await page.goto("/admin");
  await settle(page);
  await page.getByRole("listitem").filter({ hasText: "Anthropic (Claude)" }).getByRole("button", { name: "Подключить" }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg.getByText("Проверка ключа обращается к провайдеру")).toBeVisible();
  await dlg.getByLabel("API-ключ").fill(KEY);
  expect(await dlg.getByLabel("API-ключ").getAttribute("type")).toBe("password");
  await expect(dlg.getByRole("button", { name: "Подключить" })).toBeDisabled(); // без имени модели подключить нельзя
  await dlg.getByLabel("Модель").fill("test-model");
  await dlg.getByRole("button", { name: "Подключить" }).click();
  await expect(page.getByLabel("Маска ключа").filter({ hasText: "sk-••••EY99" })).toBeVisible();
  expect(await page.locator("body").innerText()).not.toContain("TESTKEYTESTKEY");
  expect(await page.content()).not.toContain("TESTKEYTESTKEY");
  expect(await storageDump(page)).not.toContain("TESTKEYTESTKEY");
});

test("биллинг: «Пополнить» отключена, цены не выдуманы", async ({ page }) => {
  await page.goto("/billing");
  await settle(page);
  await expect(page.getByRole("button", { name: /Пополнить/ })).toBeDisabled();
  await expect(page.getByText("до этого цены не показываются")).toBeVisible();
});

test("состояния: error / empty / нет истории мониторинга / loading", async ({ page }) => {
  await page.goto("/servers?demo=error");
  await expect(page.getByText("Сервис недоступен")).toBeVisible();
  await expect(page.getByRole("button", { name: "Повторить" })).toBeVisible();

  await page.goto("/servers?demo=empty");
  await expect(page.getByText("Серверов пока нет")).toBeVisible();

  await page.goto("/monitoring?demo=nohistory");
  await expect(page.getByText("Недостаточно данных").first()).toBeVisible();
  await expect(page.getByRole("img", { name: /График CPU/ })).toHaveCount(0);

  await page.goto("/monitoring");
  await settle(page);
  await expect(page.getByRole("img", { name: /График CPU, RAM и диска/ })).toBeVisible();

  await page.goto("/servers?demo=loading");
  await expect(page.getByRole("status").filter({ hasText: "Загрузка серверов" })).toBeVisible();
});

test("офлайн-сервер: «недоступен — последняя успешная проверка» вместо «всё нормально»", async ({ page }) => {
  await page.goto("/servers/srv_demo_archive");
  await settle(page);
  await expect(page.getByText(/Сервер недоступен — последняя успешная проверка: \d\d:\d\d UTC/).first()).toBeVisible();
});

test("mobile 390: нижняя навигация, «Ещё» открывает drawer, переход в Биллинг", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard");
  await settle(page);
  const nav = page.getByRole("navigation", { name: "Быстрая навигация" });
  await expect(nav).toBeVisible();
  await expect(nav.getByRole("link")).toHaveCount(3);
  const box = await nav.getByRole("link").first().boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44); // touch-zone
  await nav.getByRole("button", { name: "Ещё" }).click();
  await page.getByRole("dialog").getByRole("link", { name: "Биллинг" }).click();
  await expect(page).toHaveURL(/\/billing/);
});

test("настройки: подтверждения R2/R3 отключить нельзя; админка видна владельцу", async ({ page }) => {
  await page.goto("/settings");
  await settle(page);
  await expect(page.getByRole("switch", { name: "Подтверждать R2" })).toBeDisabled();
  await expect(page.getByRole("switch", { name: "Подтверждать R3" })).toBeDisabled();
  await page.goto("/admin");
  await settle(page);
  await expect(page.getByRole("heading", { name: "Админка" })).toBeVisible();
  // kill switch: остановка блокирует approve
  await page.getByRole("button", { name: "Остановить исполнение" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Остановить" }).click();
  await expect(page.getByText("Исполнение ОСТАНОВЛЕНО", { exact: true })).toBeVisible();
});
