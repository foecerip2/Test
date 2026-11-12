// Синхронизация Capacitor: пишет www/config.js с адресом сайта (для страницы «Нет соединения») и запускает `cap sync android`.
// Адрес — переменная AUTOFLOW_URL (по умолчанию https://autoflow.vaylonet.ru).
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const url = (process.env.AUTOFLOW_URL || "https://autoflow.vaylonet.ru").replace(/\/+$/, "");
if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(url)) {
  console.error("AUTOFLOW_URL должен быть вида https://домен");
  process.exit(1);
}
writeFileSync(`${root}www/config.js`, `window.AUTOFLOW_URL = ${JSON.stringify(`${url}/app`)};\n`);
const r = spawnSync("pnpm", ["exec", "cap", "sync", "android"], { cwd: root, stdio: "inherit", env: process.env });
process.exit(r.status ?? 1);
