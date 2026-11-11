import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { buildLiveApi } from "@/lib/api/build";
import { createDemoApi } from "@/lib/api/demo-api";
import { resolveDataMode } from "@/lib/api/mode";

describe("режим данных", () => {
  it("NEXT_PUBLIC_DATA_MODE главнее", () => {
    expect(resolveDataMode("live", undefined)).toBe("live");
    expect(resolveDataMode("mock", "live")).toBe("demo");
    expect(resolveDataMode(" LIVE ", "mock")).toBe("live");
  });

  it("без DATA_MODE признаком live служит AUTH_MODE=live", () => {
    expect(resolveDataMode(undefined, "live")).toBe("live");
    expect(resolveDataMode("", "live")).toBe("live");
    expect(resolveDataMode(undefined, undefined)).toBe("demo");
    expect(resolveDataMode(undefined, "mock")).toBe("demo");
    expect(resolveDataMode("что-то", undefined)).toBe("demo");
  });
});

describe("гибрид API", () => {
  it("demo: демо-данные на месте", async () => {
    const api = createDemoApi(false);
    expect(api.mode).toBe("demo");
    expect((await api.companies.list({})).total).toBeGreaterThan(0);
    expect((await api.drafts.list()).length).toBeGreaterThan(0);
  });

  it("live: компании/импорт/сводка — не mock, остальные разделы честно недоступны (501), без демо-данных", async () => {
    const api = buildLiveApi();
    expect(api.mode).toBe("live");
    expect(api.authMode).toBe("live");
    for (const call of [
      () => api.drafts.list(), () => api.outbox.preview("x"), () => api.consents.withdraw("x"), () => api.conversations.list(),
      () => api.tasks.list(), () => api.campaigns.list(), () => api.jobs.list(), () => api.sources(), () => api.suppression(),
      () => api.audit(), () => api.settings.get(),
    ]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status: 501, code: "NOT_AVAILABLE" });
    }
  });

  it("live: подписка на изменения работает независимо от демо", () => {
    const api = buildLiveApi();
    let n = 0;
    const off = api.subscribe(() => { n++; });
    off();
    expect(n).toBe(0);
  });

  it("demo-данные + живой вход (старая конфигурация): данные остаются демо", async () => {
    const api = createDemoApi(true);
    expect(api.mode).toBe("demo");
    expect(api.authMode).toBe("live");
    expect((await api.companies.list({})).total).toBeGreaterThan(0);
  });
});
