import { createMockApi, type MockOptions } from "./mock";
import type { Api } from "./types";

export * from "./types";

let instance: Api | null = null;

/** Единая точка доступа к API. В Фазе 2 здесь выбирается live-адаптер по NEXT_PUBLIC_API_MODE. */
export function getApi(): Api {
  if (!instance) {
    const opts: MockOptions = {};
    if (typeof window !== "undefined") {
      const m = new URLSearchParams(window.location.search).get("mock");
      if (m === "empty") opts.empty = true;
      if (m === "error") opts.fail = true;
      if (m === "slow") opts.slow = true;
    }
    instance = createMockApi(opts);
  }
  return instance;
}
