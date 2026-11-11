import { buildLiveApi } from "./build";
import type { MockOptions } from "./mock";
import type { Api } from "./types";

export * from "./types";
export { resolveDataMode, type DataMode } from "./mode";
export { SOON_TEXT, SOON_TITLE } from "./live-soon";

let instance: Api | null = null;

/**
 * Единая точка доступа к API.
 * Режим данных зашит в сборку: next.config.ts превращает NEXT_PUBLIC_DATA_MODE (а если не задана — NEXT_PUBLIC_AUTH_MODE=live)
 * в NEXT_PUBLIC_DATA_MODE=live|demo. Условие ниже статическое, поэтому в live-сборке демо-код (mock, seed, демо-вход)
 * вырезается как мёртвый и в бандл не попадает.
 */
export function getApi(): Api {
  if (!instance) {
    if (process.env.NEXT_PUBLIC_DATA_MODE === "live") {
      instance = buildLiveApi();
    } else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createDemoApi } = require("./demo-api") as typeof import("./demo-api");
      const opts: MockOptions = {};
      if (typeof window !== "undefined") {
        const flags = (new URLSearchParams(window.location.search).get("mock") ?? "").split(",");
        if (flags.includes("empty")) opts.empty = true;
        if (flags.includes("error")) opts.fail = true;
        if (flags.includes("slow")) opts.slow = true;
        if (flags.includes("fastresend")) opts.fastResend = true;
        if (flags.includes("fastexpire")) opts.fastExpire = true;
        if (flags.includes("mailerror")) opts.mailError = true;
        if (flags.includes("lastowner")) opts.lastOwner = true;
      }
      instance = createDemoApi(process.env.NEXT_PUBLIC_AUTH_MODE === "live", opts);
    }
  }
  return instance;
}

/** true в рабочем режиме: демо-данных и выдуманных чисел нет, недоступные разделы помечены «скоро». */
export const isLive = (): boolean => process.env.NEXT_PUBLIC_DATA_MODE === "live";
