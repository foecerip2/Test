import { test } from "@playwright/test";
import { installFakeServer } from "./fake-server";

/** Скриншоты live-режима для docs/screenshots/live. Запуск: SCREENSHOTS=1 pnpm exec playwright test e2e/live/screenshots.spec.ts */
test.skip(!process.env.SCREENSHOTS, "только по SCREENSHOTS=1");
test.use({ deviceScaleFactor: 2 });

const OUT = "../../docs/screenshots/live";
const companies = [
  { name: "СТО «Гермес»", city: "Казань", score: 82, website: "https://hermes-sto.ru", domain: "hermes-sto.ru" },
  { name: "Автоцентр «Вектор»", city: "Уфа", score: 78, stage: "contacted" as const },
  { name: "Шиномонтаж на Ленина", city: "Самара", score: 64 },
  { name: "Кузовной цех «Ромб»", city: "Казань", score: 58, stage: "replied" as const },
  { name: "Детейлинг-студия «Блик»", city: "Уфа", score: 41, stage: "interested" as const },
  { name: "Автомойка «Каскад»", city: "Тверь", score: 35 },
  { name: "СТО «Мотор-Сервис»", city: "Самара", score: 35, stage: "pilot" as const },
  { name: "Магазин автозапчастей «Деталь»", city: "Казань", score: 10 },
];
const CSV = "название;город;категория;сайт\nСТО «Гермес»;Казань;Автосервис;hermes-sto.ru\nАвтосервис «Орбита»;Уфа;Автосервис;orbita-auto.ru\nШиномонтаж «Круг»;Самара;Шиномонтаж;\n;Тверь;Автосервис;\nСТО «Гермес»;Казань;Автосервис;\n";

test("скриншоты", async ({ page, baseURL }, info) => {
  const tag = info.project.name === "live-mobile" ? "mobile" : "desktop";
  const shot = (name: string) => page.screenshot({ path: `${OUT}/${name}-${tag}.png`, fullPage: false });

  // 1. Пустая база
  await installFakeServer(page, baseURL!, { loggedIn: true });
  await page.goto("/companies");
  await page.getByRole("heading", { name: "Загрузите свой CSV" }).waitFor();
  await shot("01-empty");

  // 2. Импорт (dry-run)
  await page.getByRole("button", { name: "Импорт CSV" }).last().click();
  await page.locator('input[type="file"]').setInputFiles({ name: "companies.csv", mimeType: "text/csv", buffer: Buffer.from(CSV, "utf-8") });
  await page.getByText("Предпросмотр (dry-run)").waitFor();
  await shot("02-import-dryrun");
  await page.context().unrouteAll();

  // 3. Список с данными, 4. карточка, 5. «скоро», 6. обзор
  await installFakeServer(page, baseURL!, { loggedIn: true, companies });
  await page.goto("/companies");
  await page.locator("a.cell-name").first().waitFor();
  await shot("03-list");
  await page.getByRole("link", { name: "СТО «Гермес»", exact: true }).click();
  await page.getByRole("heading", { level: 1, name: "СТО «Гермес»" }).waitFor();
  await page.waitForTimeout(300);
  await shot("04-card");
  await page.screenshot({ path: `${OUT}/04-card-full-${tag}.png`, fullPage: true });
  await page.goto("/approvals");
  await page.getByTestId("coming-soon").waitFor();
  await shot("05-soon");
  await page.goto("/overview");
  await page.getByText("Компании в базе").waitFor();
  await shot("06-overview");
});
