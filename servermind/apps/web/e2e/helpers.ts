import { expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

export const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "768", width: 768, height: 1024 },
  { name: "390", width: 390, height: 844 },
  { name: "360", width: 360, height: 740 },
  { name: "320", width: 320, height: 640 },
] as const;

export const ROUTES = [
  "/login", "/onboarding", "/dashboard", "/servers", "/servers/new", "/servers/srv_demo_web1", "/assistant?server=srv_demo_web1",
  "/operations", "/operations/op_demo_restart", "/operations/op_plan_demo_docker/approve", "/deploy", "/monitoring", "/billing",
  "/settings", "/admin",
] as const;

/** Ждём, пока исчезнут все скелетоны/индикаторы загрузки (aria-busy). */
export async function settle(page: Page, timeout = 15_000) {
  await page.waitForLoadState("networkidle");
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout });
}

export async function hasHorizontalOverflow(page: Page): Promise<{ overflow: boolean; scrollWidth: number; innerWidth: number; offender: string | null }> {
  return page.evaluate(() => {
    const de = document.documentElement;
    const over = de.scrollWidth > window.innerWidth + 1;
    let offender: string | null = null;
    if (over) {
      for (const el of Array.from(document.body.querySelectorAll("*"))) {
        const r = el.getBoundingClientRect();
        if (r.right > window.innerWidth + 1 && r.width > 0) {
          offender = `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).slice(0, 80)}`;
          break;
        }
      }
    }
    return { overflow: over, scrollWidth: de.scrollWidth, innerWidth: window.innerWidth, offender };
  });
}

const SHOT_DIR = path.resolve(__dirname, "../../../docs/design/screenshots");
export async function shot(page: Page, name: string, fullPage = false) {
  if (process.env.SCREENSHOTS !== "1") return;
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage });
}

export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}
