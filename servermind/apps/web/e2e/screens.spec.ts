import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { ROUTES, VIEWPORTS, collectConsoleErrors, hasHorizontalOverflow, settle } from "./helpers";

// Адаптивность: ни на одном экране и ни в одном размере (320–1440) не должно быть горизонтального скролла страницы.
for (const route of ROUTES) {
  for (const vp of VIEWPORTS) {
    test(`без горизонтального overflow и ошибок консоли: ${route} @${vp.name}`, async ({ page }) => {
      const errors = collectConsoleErrors(page);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(route);
      await settle(page);
      const o = await hasHorizontalOverflow(page);
      expect(o.overflow, `scrollWidth=${o.scrollWidth} > innerWidth=${o.innerWidth}; элемент: ${o.offender}`).toBe(false);
      expect(errors, errors.join("\n")).toEqual([]);
    });
  }
}

// Доступность (smoke): axe WCAG 2.0/2.1 A+AA. Падаем на serious/critical.
for (const route of ROUTES) {
  for (const vp of [VIEWPORTS[0], VIEWPORTS[2]]) {
    test(`axe a11y: ${route} @${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(route);
      await settle(page);
      const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const bad = res.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(
        bad.map((v) => `${v.id} [${v.impact}] ×${v.nodes.length}: ${v.nodes[0]?.target.join(" ")} — ${v.help}`),
      ).toEqual([]);
    });
  }
}

test("200% zoom (эквивалент 720px ширины на desktop) — без overflow", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 450 });
  for (const r of ["/dashboard", "/servers", "/billing", "/operations/op_plan_demo_docker/approve"]) {
    await page.goto(r);
    await settle(page);
    expect((await hasHorizontalOverflow(page)).overflow, r).toBe(false);
  }
});

test("prefers-reduced-motion: страницы работают, анимации отключены", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/dashboard");
  await settle(page);
  const dur = await page.evaluate(() => getComputedStyle(document.querySelector("a")!).transitionDuration);
  expect(parseFloat(dur)).toBeLessThan(0.01);
});
