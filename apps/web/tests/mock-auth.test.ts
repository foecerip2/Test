import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { createLiveAuth } from "@/lib/api/live-auth";
import { createMockAuth, DEMO_CODE, MAX_ATTEMPTS } from "@/lib/api/mock-auth";

function memStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
}
function setup(over: Parameters<typeof createMockAuth>[0] = {}) {
  const clock = { t: 1_000_000 };
  const auth = createMockAuth({ now: () => clock.t, latency: 0, storage: memStore(), ...over });
  return { auth, clock };
}
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ApiError; } throw new Error("ожидалась ошибка"); };

describe("mock auth: запрос и проверка кода", () => {
  it("принимает любой валидный email и возвращает параметры кода", async () => {
    const { auth } = setup();
    const c = await auth.requestCode("anna@mail.ru");
    expect(c.expiresIn).toBe(600);
    expect(c.resendIn).toBe(60);
    expect(c.challengeId).toBeTruthy();
  });
  it("невалидный email → INVALID_EMAIL", async () => {
    const { auth } = setup();
    expect(await fail(auth.requestCode("не-почта"))).toMatchObject({ status: 400, code: "INVALID_EMAIL" });
  });
  it("демо-код 123456: создаёт сессию, is_new только в первый раз", async () => {
    const { auth } = setup();
    expect(await auth.me()).toBeNull();
    const c1 = await auth.requestCode("a@b.ru");
    const r1 = await auth.verifyCode(c1.challengeId, DEMO_CODE);
    expect(r1.isNew).toBe(true);
    expect(r1.user).toMatchObject({ email: "a@b.ru", status: "active", role: "user" });
    expect(await auth.me()).toMatchObject({ email: "a@b.ru" });
    await auth.logout();
    expect(await auth.me()).toBeNull();
    const c2 = await auth.requestCode("A@b.ru");
    expect((await auth.verifyCode(c2.challengeId, DEMO_CODE)).isNew).toBe(false);
  });
  it("email с «pending» получает статус pending, «owner» — роль owner", async () => {
    const { auth } = setup();
    const c = await auth.requestCode("pending.user@x.ru");
    expect((await auth.verifyCode(c.challengeId, DEMO_CODE)).user.status).toBe("pending");
    const o = await auth.requestCode("owner@x.ru");
    expect((await auth.verifyCode(o.challengeId, DEMO_CODE)).user.role).toBe("owner");
  });
  it("неверный код: счётчик попыток, на пятой — блокировка", async () => {
    const { auth } = setup();
    const c = await auth.requestCode("a@b.ru");
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const e = await fail(auth.verifyCode(c.challengeId, "000000"));
      expect(e).toMatchObject({ status: 400, code: "INVALID_CODE", details: { attemptsLeft: MAX_ATTEMPTS - i } });
    }
    expect(await fail(auth.verifyCode(c.challengeId, "000000"))).toMatchObject({ status: 429, code: "TOO_MANY_ATTEMPTS" });
    // после лимита даже верный код не принимается
    expect(await fail(auth.verifyCode(c.challengeId, DEMO_CODE))).toMatchObject({ code: "TOO_MANY_ATTEMPTS" });
  });
  it("TTL: по истечении 600 с → CODE_EXPIRED", async () => {
    const { auth, clock } = setup();
    const c = await auth.requestCode("a@b.ru");
    clock.t += 599_000;
    await expect(auth.verifyCode(c.challengeId, "111111")).rejects.toMatchObject({ code: "INVALID_CODE" });
    clock.t += 2_000;
    expect(await fail(auth.verifyCode(c.challengeId, DEMO_CODE))).toMatchObject({ status: 410, code: "CODE_EXPIRED" });
  });
  it("неизвестный challenge → CODE_EXPIRED", async () => {
    const { auth } = setup();
    expect(await fail(auth.verifyCode("nope", DEMO_CODE))).toMatchObject({ status: 410 });
  });
});

describe("mock auth: повторная отправка и режимы", () => {
  it("cooldown 60 с: раньше — RATE_LIMITED с retryAfter, потом ок и сброс попыток", async () => {
    const { auth, clock } = setup();
    const c = await auth.requestCode("a@b.ru");
    await fail(auth.verifyCode(c.challengeId, "000000"));
    clock.t += 20_000;
    expect(await fail(auth.resendCode(c.challengeId))).toMatchObject({ status: 429, code: "RATE_LIMITED", details: { retryAfter: 40 } });
    clock.t += 40_000;
    expect(await auth.resendCode(c.challengeId)).toEqual({ resendIn: 60 });
    const e = await fail(auth.verifyCode(c.challengeId, "000000"));
    expect(e.details.attemptsLeft).toBe(MAX_ATTEMPTS - 1);
  });
  it("fastResend: cooldown 3 с", async () => {
    const { auth, clock } = setup({ fastResend: true });
    const c = await auth.requestCode("a@b.ru");
    expect(c.resendIn).toBe(3);
    clock.t += 3_000;
    expect(await auth.resendCode(c.challengeId)).toEqual({ resendIn: 3 });
  });
  it("fastExpire: код живёт 6 с", async () => {
    const { auth, clock } = setup({ fastExpire: true });
    const c = await auth.requestCode("a@b.ru");
    expect(c.expiresIn).toBe(6);
    clock.t += 6_000;
    expect(await fail(auth.verifyCode(c.challengeId, DEMO_CODE))).toMatchObject({ code: "CODE_EXPIRED" });
  });
  it("mailError → MAIL_UNAVAILABLE", async () => {
    const { auth } = setup({ mailError: true });
    expect(await fail(auth.requestCode("a@b.ru"))).toMatchObject({ status: 503, code: "MAIL_UNAVAILABLE" });
  });
});

describe("live auth: контракт /api/v1/auth/*", () => {
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

  it("requestCode: POST без CSRF, camelCase в ответе", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const auth = createLiveAuth(async (url, init) => { calls.push({ url, init: init! }); return json(202, { challenge_id: "c1", expires_in: 600, resend_in: 60 }); }, () => "tok");
    expect(await auth.requestCode(" a@b.ru ")).toEqual({ challengeId: "c1", expiresIn: 600, resendIn: 60 });
    expect(calls[0]!.url).toBe("/api/v1/auth/otp/request");
    expect(calls[0]!.init.credentials).toBe("same-origin");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ email: "a@b.ru" });
    expect((calls[0]!.init.headers as Record<string, string>)["X-CSRF-Token"]).toBeUndefined();
  });
  it("verifyCode: возвращает user и is_new; ошибка INVALID_CODE несёт attempts_left", async () => {
    let n = 0;
    const auth = createLiveAuth(async () => (n++ === 0
      ? json(400, { code: "INVALID_CODE", message: "x", request_id: "r1", attempts_left: 3 })
      : json(200, { user: { id: "1", email: "a@b.ru", role: "owner", status: "active" }, is_new: true })));
    expect(await fail(auth.verifyCode("c1", "000000"))).toMatchObject({ status: 400, code: "INVALID_CODE", details: { attemptsLeft: 3, requestId: "r1" } });
    expect(await auth.verifyCode("c1", "123456")).toMatchObject({ isNew: true, user: { role: "owner" } });
  });
  it("429 передаёт Retry-After", async () => {
    const auth = createLiveAuth(async () => json(429, { code: "RATE_LIMITED", message: "x", request_id: "r" }, { "Retry-After": "42" }));
    expect(await fail(auth.resendCode("c1"))).toMatchObject({ status: 429, details: { retryAfter: 42 } });
  });
  it("me: 401 → null; logout шлёт X-CSRF-Token", async () => {
    const seen: Record<string, string>[] = [];
    const auth = createLiveAuth(async (url, init) => {
      seen.push(init!.headers as Record<string, string>);
      return url.endsWith("/me") ? json(401, { code: "UNAUTHORIZED", message: "x", request_id: "r" }) : json(204, null);
    }, () => "csrf-1");
    expect(await auth.me()).toBeNull();
    await auth.logout();
    expect(seen[1]!["X-CSRF-Token"]).toBe("csrf-1");
  });
  it("сетевой сбой → NETWORK", async () => {
    const auth = createLiveAuth(async () => { throw new TypeError("fail"); });
    expect(await fail(auth.requestCode("a@b.ru"))).toMatchObject({ code: "NETWORK" });
  });
});
