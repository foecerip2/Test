import { createLiveAuth } from "./live-auth";
import { createMockApi, type MockOptions } from "./mock";
import type { Api } from "./types";

export * from "./types";

let instance: Api | null = null;

/**
 * Единая точка доступа к API. Данные — mock (Фаза 1). Вход (auth) — гибрид:
 * при NEXT_PUBLIC_AUTH_MODE=live берётся настоящий клиент /api/v1/auth/*, иначе демо-вход с кодом 123456.
 */
export function getApi(): Api {
  if (!instance) {
    const opts: MockOptions = {};
    if (typeof window !== "undefined") {
      const flags = (new URLSearchParams(window.location.search).get("mock") ?? "").split(",");
      if (flags.includes("empty")) opts.empty = true;
      if (flags.includes("error")) opts.fail = true;
      if (flags.includes("slow")) opts.slow = true;
      if (flags.includes("fastresend")) opts.fastResend = true;
      if (flags.includes("fastexpire")) opts.fastExpire = true;
      if (flags.includes("mailerror")) opts.mailError = true;
    }
    const mock = createMockApi(opts);
    instance = process.env.NEXT_PUBLIC_AUTH_MODE === "live" ? { ...mock, authMode: "live", auth: createLiveAuth() } : mock;
  }
  return instance;
}
