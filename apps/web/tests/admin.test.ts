import { describe, expect, it } from "vitest";
import { ApiError, type AdminUser } from "@/lib/api";
import { createLiveAdmin } from "@/lib/api/live-admin";
import { createMockAdmin } from "@/lib/api/mock-admin";
import { createMockAuth } from "@/lib/api/mock-auth";
import { adminErrorText, blockDisabledReason, countByStatus, pendingCount, pendingText, sortUsers } from "@/lib/users";

const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ApiError; } throw new Error("ожидалась ошибка"); };

const wire = (over: Record<string, unknown> = {}) => ({
  id: "11111111-1111-1111-1111-111111111111", email: "anna@example.com", role: "user", status: "pending",
  created_at: "2026-11-01T10:00:00+00:00", last_login_at: null, ...over,
});

function fakeFetch(res: { status?: number; body?: unknown; throws?: boolean }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    if (res.throws) throw new TypeError("offline");
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), { status: res.status ?? 200, headers: { "Content-Type": "application/json" } });
  };
  return { f, calls };
}

describe("live admin: контракт /api/v1/admin/users", () => {
  it("listUsers: GET без CSRF, same-origin, snake_case → camelCase", async () => {
    const { f, calls } = fakeFetch({ body: { users: [wire(), wire({ id: "2", status: "active", role: "owner", last_login_at: "2026-11-02T09:00:00+00:00" })] } });
    const users = await createLiveAdmin(f, () => "tok").listUsers();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/v1/admin/users");
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.credentials).toBe("same-origin");
    expect((calls[0]!.init.headers as Record<string, string>)["X-CSRF-Token"]).toBeUndefined();
    expect(users[0]).toEqual({ id: "11111111-1111-1111-1111-111111111111", email: "anna@example.com", role: "user", status: "pending", createdAt: "2026-11-01T10:00:00+00:00", lastLoginAt: null });
    expect(users[1]).toMatchObject({ role: "owner", status: "active", lastLoginAt: "2026-11-02T09:00:00+00:00" });
  });

  it("approveUser / blockUser: POST на нужный URL с X-CSRF-Token из cookie", async () => {
    const a = fakeFetch({ body: { user: wire({ status: "active" }) } });
    const approved = await createLiveAdmin(a.f, () => "csrf-1").approveUser("abc");
    expect(a.calls[0]!.url).toBe("/api/v1/admin/users/abc/approve");
    expect(a.calls[0]!.init.method).toBe("POST");
    expect((a.calls[0]!.init.headers as Record<string, string>)["X-CSRF-Token"]).toBe("csrf-1");
    expect(a.calls[0]!.init.credentials).toBe("same-origin");
    expect(approved.status).toBe("active");

    const b = fakeFetch({ body: { user: wire({ status: "blocked" }) } });
    const blocked = await createLiveAdmin(b.f, () => "csrf-2").blockUser("a b/c");
    expect(b.calls[0]!.url).toBe("/api/v1/admin/users/a%20b%2Fc/block");
    expect((b.calls[0]!.init.headers as Record<string, string>)["X-CSRF-Token"]).toBe("csrf-2");
    expect(blocked.status).toBe("blocked");
  });

  it("без cookie CSRF заголовок не добавляется (сервер ответит CSRF_FAILED)", async () => {
    const { f, calls } = fakeFetch({ status: 403, body: { code: "CSRF_FAILED", message: "x", request_id: "r1" } });
    const e = await fail(createLiveAdmin(f, () => null).approveUser("1"));
    expect((calls[0]!.init.headers as Record<string, string>)["X-CSRF-Token"]).toBeUndefined();
    expect(e).toMatchObject({ status: 403, code: "CSRF_FAILED" });
  });

  it.each([
    [400, "CANNOT_BLOCK_SELF"], [409, "LAST_OWNER"], [403, "FORBIDDEN"], [404, "NOT_FOUND"], [401, "UNAUTHENTICATED"],
  ])("ошибка %i %s → ApiError с кодом и request_id", async (status, code) => {
    const { f } = fakeFetch({ status, body: { code, message: "Текст", request_id: "req-9" } });
    const e = await fail(createLiveAdmin(f, () => "t").blockUser("1"));
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status, code, message: "Текст" });
    expect(e.details.requestId).toBe("req-9");
  });

  it("нечитаемое тело ошибки → UNKNOWN; обрыв сети → NETWORK", async () => {
    const bad = async () => new Response("<html>", { status: 502 });
    expect(await fail(createLiveAdmin(bad, () => "t").listUsers())).toMatchObject({ status: 502, code: "UNKNOWN" });
    const { f } = fakeFetch({ throws: true });
    expect(await fail(createLiveAdmin(f, () => "t").listUsers())).toMatchObject({ status: 0, code: "NETWORK" });
  });
});

function setupMock(email: string, over: Partial<Parameters<typeof createMockAdmin>[0]> = {}) {
  const m = new Map<string, string>();
  const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
  const auth = createMockAuth({ latency: 0, storage });
  const admin = createMockAdmin({ auth, latency: 0, ...over });
  const login = async () => { const c = await auth.requestCode(email); await auth.verifyCode(c.challengeId, "123456"); };
  return { auth, admin, login };
}

describe("mock admin: правила как у бэкенда", () => {
  it("без входа — 401, обычный пользователь — 403 FORBIDDEN", async () => {
    const { admin, login } = setupMock("anna@example.com");
    expect(await fail(admin.listUsers())).toMatchObject({ status: 401 });
    await login();
    expect(await fail(admin.listUsers())).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(await fail(admin.approveUser("usr_maria"))).toMatchObject({ status: 403 });
  });

  it("owner видит демо-данные: себя, 2 активных, 3 ожидающих, 1 заблокированного", async () => {
    const { admin, login } = setupMock("owner@example.com");
    await login();
    const list = await admin.listUsers();
    expect(countByStatus(list)).toEqual({ pending: 3, active: 3, blocked: 1 });
    expect(list.filter((u) => u.role === "owner")).toHaveLength(1);
    expect(list.find((u) => u.role === "owner")!.email).toBe("owner@example.com");
  });

  it("approve: pending и blocked → active; состояние сохраняется", async () => {
    const { admin, login } = setupMock("owner@example.com");
    await login();
    expect((await admin.approveUser("usr_maria")).status).toBe("active");
    expect((await admin.approveUser("usr_spam")).status).toBe("active");
    const list = await admin.listUsers();
    expect(countByStatus(list)).toEqual({ pending: 2, active: 5, blocked: 0 });
  });

  it("block: active и pending → blocked; нет пользователя → 404", async () => {
    const { admin, login } = setupMock("owner@example.com");
    await login();
    expect((await admin.blockUser("usr_anna")).status).toBe("blocked");
    expect((await admin.blockUser("usr_ivan")).status).toBe("blocked");
    expect(await fail(admin.blockUser("nope"))).toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("нельзя заблокировать себя: 400 CANNOT_BLOCK_SELF", async () => {
    const { admin, auth, login } = setupMock("owner@example.com");
    await login();
    const me = (await auth.me())!;
    await admin.listUsers();
    expect(await fail(admin.blockUser(me.id))).toMatchObject({ status: 400, code: "CANNOT_BLOCK_SELF" });
  });

  it("последний владелец: 409 LAST_OWNER (флаг lastOwner — гонка на сервере)", async () => {
    const { admin, login } = setupMock("owner@example.com", { lastOwner: true });
    await login();
    const list = await admin.listUsers();
    const co = list.find((u) => u.email === "co-owner@example.com")!;
    expect(await fail(admin.blockUser(co.id))).toMatchObject({ status: 409, code: "LAST_OWNER" });
  });

  it("notify вызывается после изменения, но не после отказа", async () => {
    let n = 0;
    const { admin, login } = setupMock("owner@example.com", { notify: () => { n += 1; } });
    await login();
    await admin.listUsers();
    await admin.approveUser("usr_maria");
    expect(n).toBe(1);
    await fail(admin.blockUser("nope"));
    expect(n).toBe(1);
  });

  it("?mock=error: чтение падает с 503", async () => {
    const { admin, login } = setupMock("owner@example.com", { fail: true });
    await login();
    expect(await fail(admin.listUsers())).toMatchObject({ status: 503 });
  });
});

const U = (o: Partial<AdminUser>): AdminUser => ({ id: "x", email: "x@example.com", role: "user", status: "active", createdAt: "2026-11-01T00:00:00Z", lastLoginAt: null, ...o });

describe("users: вспомогательные функции", () => {
  it("sortUsers: ожидающие → активные → заблокированные, новые выше", () => {
    const s = sortUsers([
      U({ id: "b", status: "blocked" }), U({ id: "a1", status: "active", createdAt: "2026-10-01T00:00:00Z" }),
      U({ id: "p1", status: "pending", createdAt: "2026-11-02T00:00:00Z" }), U({ id: "p2", status: "pending", createdAt: "2026-11-05T00:00:00Z" }),
      U({ id: "a2", status: "active", createdAt: "2026-10-09T00:00:00Z" }),
    ]);
    expect(s.map((u) => u.id)).toEqual(["p2", "p1", "a2", "a1", "b"]);
  });

  it("pendingText: склонение", () => {
    expect(pendingText(1)).toBe("1 пользователь ждёт одобрения");
    expect(pendingText(3)).toBe("3 пользователя ждут одобрения");
    expect(pendingText(5)).toBe("5 пользователей ждут одобрения");
    expect(pendingText(11)).toBe("11 пользователей ждут одобрения");
    expect(pendingText(21)).toBe("21 пользователь ждёт одобрения");
    expect(pendingText(22)).toBe("22 пользователя ждут одобрения");
  });

  it("pendingCount считает только pending и терпит null", () => {
    expect(pendingCount(null)).toBe(0);
    expect(pendingCount([U({ status: "pending" }), U({ status: "active" }), U({ status: "pending" })])).toBe(2);
  });

  it("blockDisabledReason: себя и последнего владельца нельзя", () => {
    const me = U({ id: "me", role: "owner" });
    const other = U({ id: "o2", role: "owner" });
    expect(blockDisabledReason(me, "me", [me, other])).toMatch(/себя/);
    expect(blockDisabledReason(other, "me", [me, other])).toBeNull();
    expect(blockDisabledReason(other, "zzz", [other])).toMatch(/последнего владельца/);
    expect(blockDisabledReason(U({ id: "u" }), "me", [me, U({ id: "u" })])).toBeNull();
  });

  it("adminErrorText: русские тексты по кодам, без сообщений сервера", () => {
    expect(adminErrorText(new ApiError(400, "CANNOT_BLOCK_SELF", "english"))).toMatch(/самого себя/);
    expect(adminErrorText(new ApiError(409, "LAST_OWNER", "english"))).toMatch(/последнего владельца/);
    expect(adminErrorText(new ApiError(0, "NETWORK", "x"))).toMatch(/соединения/);
    expect(adminErrorText(new Error("boom"))).toMatch(/Не удалось/);
  });
});
