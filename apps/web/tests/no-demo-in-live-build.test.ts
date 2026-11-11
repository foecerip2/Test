/**
 * В рабочей (live) сборке не должно быть демо-кода и вымышленных данных: ни в клиентском бандле (.next/static),
 * ни в серверной части (.next/server). Условие `process.env.NEXT_PUBLIC_DATA_MODE === "live"` статическое,
 * поэтому mock, seed и демо-тексты вырезаются как мёртвый код.
 *
 *  - `pnpm --filter web check:live-bundle` — собирает live-вариант в отдельный каталог и проверяет его;
 *  - обычный `vitest run` проверяет уже готовую сборку `.next-live` (её делает webServer e2e), а если её нет — пропускает.
 */
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const BUILD = process.env.LIVE_BUNDLE_BUILD === "1";
const DIR = join(ROOT, BUILD ? ".next-live-check" : ".next-live");

/** Маркеры демо-данных и демо-кода (вымышленные компании, демо-код входа, названия режимов, домены-примеры). */
const MARKERS = [
  "Северный мотор", "Пятый бокс", "МоторЛайн", "Гараж 24", "ТестАвто", ".example", "123456",
  "Демо-данные", "Демонстрационные данные", "Демо:", "mock", "createMockApi",
];

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(js|html|rsc|json|css)$/.test(name)) out.push(p);
  }
  return out;
}

/** Найденные маркеры вместе с файлами. polyfills — сторонний код со случайными числами, исключён. */
function scanDir(dir: string): string[] {
  const hits: string[] = [];
  for (const sub of ["static", "server"]) {
    const base = join(dir, sub);
    if (!existsSync(base)) continue;
    for (const f of files(base)) {
      if (/polyfills/.test(f) || /\.nft\.json$/.test(f) || /[\\/]cache[\\/]/.test(f)) continue;
      const text = readFileSync(f, "utf-8");
      for (const m of MARKERS) if (text.includes(m)) hits.push(`${m} → ${f.slice(dir.length)}`);
    }
  }
  return hits;
}

describe("live-сборка без демо-данных", () => {
  it("сканер реально ищет (самопроверка на демо-файлах)", () => {
    const demo = join(ROOT, "src/lib/api");
    expect(readFileSync(join(demo, "seed.ts"), "utf-8")).toContain("Северный мотор");
    expect(scanDir(ROOT + "/src")).toEqual([]); // в src нет static/server — пусто
  });

  it.skipIf(!BUILD && !existsSync(DIR))("в бандле нет mock, seed, вымышленных компаний и демо-текстов", { timeout: 360_000 }, () => {
    if (BUILD) {
      execSync("pnpm exec next build", {
        cwd: ROOT, stdio: "pipe", timeout: 300_000,
        env: { ...process.env, NEXT_PUBLIC_AUTH_MODE: "live", NEXT_PUBLIC_DATA_MODE: "live", NEXT_DIST_DIR: ".next-live-check", NEXT_TELEMETRY_DISABLED: "1" },
      });
    }
    expect(scanDir(DIR)).toEqual([]);
  });
});
