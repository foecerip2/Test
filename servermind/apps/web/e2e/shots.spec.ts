import { test } from "@playwright/test";
import { settle, shot } from "./helpers";

// Скриншоты для docs/design/screenshots (запуск: npm run shots). На всех кадрах виден ribbon «Демо-данные».
const D = { width: 1440, height: 900 };
const M = { width: 390, height: 844 };

test.describe("скриншоты", () => {
  test("dashboard + login + списки (desktop/mobile)", async ({ page }) => {
    await page.setViewportSize(D);
    for (const [name, url] of [["login", "/login"], ["dashboard", "/dashboard"], ["servers", "/servers"], ["server-detail", "/servers/srv_demo_web1"], ["operations", "/operations"], ["settings", "/settings"], ["admin", "/admin"]] as const) {
      await page.goto(url); await settle(page); await shot(page, `${name}-desktop-1440`);
    }
    await page.setViewportSize(M);
    for (const [name, url] of [["login", "/login"], ["dashboard", "/dashboard"], ["servers", "/servers"], ["server-detail", "/servers/srv_demo_web1"], ["operations", "/operations"], ["settings", "/settings"]] as const) {
      await page.goto(url); await settle(page); await shot(page, `${name}-mobile-390`);
    }
    await page.goto("/dashboard"); await settle(page);
    await page.getByRole("button", { name: "Ещё" }).click();
    await page.waitForTimeout(400);
    await shot(page, "drawer-mobile-390");
  });

  test("онбординг SSH: данные и отпечаток (desktop/mobile)", async ({ page }) => {
    for (const [tag, vp] of [["desktop-1440", D], ["mobile-390", M]] as const) {
      await page.setViewportSize(vp);
      await page.goto("/servers/new"); await settle(page);
      await shot(page, `onboarding-ssh-${tag}`, true);
      await page.getByLabel("IP-адрес или домен").fill("203.0.113.50");
      await page.getByRole("button", { name: "Получить отпечаток сервера" }).click();
      await page.getByRole("heading", { name: "2. Сверьте отпечаток сервера" }).waitFor();
      await shot(page, `onboarding-fingerprint-${tag}`);
    }
  });

  test("ассистент mobile + подтверждение (диалог) + выполнение", async ({ page }) => {
    await page.setViewportSize(M);
    await page.goto("/assistant?server=srv_demo_web1"); await settle(page);
    await shot(page, "assistant-empty-mobile-390");
    await page.getByLabel("Сообщение ассистенту").fill("Почему сайт отвечает 502?");
    await page.getByLabel("Сообщение ассистенту").press("Enter");
    await page.getByText("Предлагаемый план").waitFor({ timeout: 15_000 });
    await page.waitForTimeout(500);
    await shot(page, "assistant-mobile-390");

    await page.setViewportSize(D);
    await page.goto("/assistant?server=srv_demo_web1"); await settle(page);
    await shot(page, "assistant-desktop-1440");

    await page.goto("/operations/op_plan_demo_docker/approve"); await settle(page);
    await shot(page, "approval-desktop-1440", true);
    await page.getByRole("button", { name: "Подтвердить…" }).click();
    await page.getByRole("dialog").getByRole("checkbox").click();
    await page.waitForTimeout(350);
    await shot(page, "approval-modal-desktop-1440");

    await page.setViewportSize(M);
    await page.goto("/operations/op_plan_demo_docker/approve"); await settle(page);
    await page.getByRole("button", { name: "Подтвердить…" }).click();
    await page.waitForTimeout(350);
    await shot(page, "approval-modal-mobile-390");
    await page.getByRole("dialog").getByRole("checkbox").click();
    await page.getByRole("button", { name: "Подтвердить и выполнить" }).click();
    await page.getByText("Выполняется", { exact: true }).first().waitFor();
    await page.waitForTimeout(3200);
    await shot(page, "deploy-running-mobile-390");
    await page.setViewportSize(D);
    await shot(page, "deploy-running-desktop-1440");
  });

  test("деплой, биллинг, мониторинг (в т.ч. пустой)", async ({ page }) => {
    await page.setViewportSize(D);
    await page.goto("/deploy"); await settle(page); await shot(page, "deploy-wizard-desktop-1440");
    await page.goto("/billing"); await settle(page); await shot(page, "billing-credits-desktop-1440");
    await page.getByRole("tab", { name: /Собственные подключения/ }).click(); await shot(page, "billing-byok-desktop-1440");
    await page.goto("/monitoring"); await settle(page); await shot(page, "monitoring-populated-desktop-1440");
    await page.goto("/monitoring?demo=nohistory"); await settle(page); await shot(page, "monitoring-empty-desktop-1440");
    await page.goto("/servers?demo=error"); await settle(page, 20_000); await shot(page, "state-error-desktop-1440");
    await page.goto("/servers?demo=empty"); await settle(page); await shot(page, "state-empty-desktop-1440");
    await page.goto("/servers?demo=loading"); await page.waitForTimeout(600); await shot(page, "state-loading-desktop-1440");

    await page.setViewportSize(M);
    await page.goto("/billing"); await settle(page); await shot(page, "billing-mobile-390");
    await page.goto("/monitoring"); await settle(page); await shot(page, "monitoring-populated-mobile-390");
    await page.goto("/monitoring?demo=nohistory"); await settle(page); await shot(page, "monitoring-empty-mobile-390");
    await page.goto("/deploy"); await settle(page); await shot(page, "deploy-wizard-mobile-390");
  });
});
