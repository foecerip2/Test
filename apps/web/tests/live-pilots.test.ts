import { describe, expect, it, vi } from "vitest";
import { createLivePilots } from "../src/lib/api/live-pilots";
import { toSummary } from "../src/lib/api/live-companies";

const row = {
  id: "pilot-1", business_name: "Авто Север", city: "Казань", contact_name: "Иван", phone: "+79991234567", email: null,
  status: "new", note: "", consent_at: "2026-11-11T12:00:00Z", consent_text_version: "v1",
  created_at: "2026-11-11T12:00:00Z", updated_at: "2026-11-11T12:00:00Z",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("заявки AutoFlow: реальный API-клиент", () => {
  it("передаёт фильтр и непрозрачный курсор, ограничивает размер страницы, преобразует поля", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ items: [row], next_cursor: "opaque-next" }));
    const page = await createLivePilots(fetcher).list({ status: "new", cursor: "a+/=", limit: 900 });
    const [url, init] = fetcher.mock.calls[0]!;
    const params = new URL(url, "https://localhost").searchParams;
    expect(params.get("status")).toBe("new");
    expect(params.get("cursor")).toBe("a+/=");
    expect(params.get("limit")).toBe("100");
    expect(init).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store" });
    expect(page.nextCursor).toBe("opaque-next");
    expect(page.items[0]).toMatchObject({ businessName: "Авто Север", contactName: "Иван", phone: row.phone, email: null, consentTextVersion: "v1" });
  });
  it("PATCH отправляет только правки с CSRF и оповещает подписчиков после успеха", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ ...row, status: "contacted", note: "Позвонить завтра" }));
    const notify = vi.fn();
    const updated = await createLivePilots(fetcher, () => "csrf-token", notify).update("id/with/slash", { status: "contacted", note: "Позвонить завтра" });
    expect(fetcher.mock.calls[0]).toEqual(["/api/v1/autoflow/pilot-requests/id%2Fwith%2Fslash", expect.objectContaining({
      method: "PATCH", credentials: "same-origin", headers: expect.objectContaining({ "X-CSRF-Token": "csrf-token", "Content-Type": "application/json" }),
      body: JSON.stringify({ status: "contacted", note: "Позвонить завтра" }),
    })]);
    expect(updated.status).toBe("contacted");
    expect(notify).toHaveBeenCalledOnce();
  });
  it.each([401, 403, 404, 422, 429, 503])("не маскирует ошибку сервера %s под успех", async (status) => {
    const notify = vi.fn();
    const api = createLivePilots(vi.fn().mockResolvedValue(json({ code: "FORBIDDEN" }, status)), () => null, notify);
    await expect(api.update("pilot-1", { status: "spam" })).rejects.toMatchObject({ status, code: "FORBIDDEN" });
    expect(notify).not.toHaveBeenCalled();
  });
  it("обрабатывает сетевой сбой и HTML вместо JSON", async () => {
    await expect(createLivePilots(vi.fn().mockRejectedValue(new Error("offline"))).list({})).rejects.toMatchObject({ code: "NETWORK" });
    await expect(createLivePilots(vi.fn().mockResolvedValue(new Response("<html>error</html>", { status: 502 }))).list({})).rejects.toMatchObject({ status: 502 });
    await expect(createLivePilots(vi.fn().mockResolvedValue(json({}))).list({})).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it("сводка сохраняет настоящий ноль заявок, но не придумывает его при отсутствии поля", () => {
    expect(toSummary({ pilot_requests_new: 0 }).pilotRequestsNew).toBe(0);
    expect(toSummary({}).pilotRequestsNew).toBeUndefined();
  });
  it.each([{ status: "unknown" }, { created_at: "not-a-date" }, { contact_name: null }])("некорректная заявка не приводит к падению страницы: %j", async (patch) => {
    const api = createLivePilots(vi.fn().mockResolvedValue(json({ items: [{ ...row, ...patch }], next_cursor: null })));
    await expect(api.list({})).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
