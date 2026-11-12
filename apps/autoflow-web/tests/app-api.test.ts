import { afterEach, describe, expect, it, vi } from "vitest";
import { appApi, AppError, timeLabel, timeValue } from "../src/lib/app-api";

afterEach(() => vi.unstubAllGlobals());
describe("настоящий API AutoFlow", () => {
  it("использует отдельный cookie CSRF, JSON, no-store и тот же origin", async () => {
    vi.stubGlobal("document", {
      cookie: "lh_csrf=wrong; af_csrf=autoflow-token",
    });
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "real-record" }), { status: 201 }),
      );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      appApi("/app/services", "POST", { name: "Диагностика", duration: 60 }),
    ).resolves.toEqual({ id: "real-record" });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/autoflow/app/services",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: expect.objectContaining({ "X-CSRF-Token": "autoflow-token" }),
      }),
    );
  });
  it("вход не зависит от сессии или CSRF LeadHunter", async () => {
    vi.stubGlobal("document", { cookie: "lh_csrf=wrong" });
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ challenge_id: "test" }), { status: 202 }),
      );
    vi.stubGlobal("fetch", fetcher);
    await appApi("/auth/otp/request", "POST", { email: "owner@example.com" });
    expect(fetcher.mock.calls[0]![0]).toBe("/api/v1/autoflow/auth/otp/request");
    expect(fetcher.mock.calls[0]![1].headers).not.toHaveProperty(
      "X-CSRF-Token",
    );
  });
  it.each([
    [403, "FORBIDDEN"],
    [409, "SLOT_TAKEN"],
    [422, "OUTSIDE_HOURS"],
    [503, "MAIL_UNAVAILABLE"],
  ])(
    "ошибка %s не превращается в успешное сохранение",
    async (status, code) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({ code }), { status: Number(status) }),
          ),
      );
      await expect(appApi("/app/state")).rejects.toMatchObject({
        status,
        code,
      });
    },
  );
  it("не раскрывает подробности серверных ошибок и обрабатывает не-JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              code: "INTERNAL",
              message: "private database path",
            }),
            { status: 500 },
          ),
        ),
    );
    await expect(appApi("/app/state")).rejects.toThrow(
      "Сервис временно недоступен",
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("<html>broken</html>", { status: 200 }),
        ),
    );
    await expect(appApi("/app/state")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
  it("сеть и 204 обработаны без ложного успеха", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(appApi("/account")).rejects.toBeInstanceOf(AppError);
    vi.stubGlobal("document", { cookie: "af_csrf=test" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    );
    await expect(appApi("/auth/logout", "POST")).resolves.toBeUndefined();
  });
  it("локальное время записи не теряет минуты при преобразовании", () => {
    expect(timeValue("09:45")).toBe(585);
    expect(timeLabel(585)).toBe("09:45");
  });
});
