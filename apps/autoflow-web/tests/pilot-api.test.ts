import { describe, expect, it, vi } from "vitest";
import { classifyStatus, submitPilot } from "@/lib/pilot-api";
import type { PilotPayload } from "@/lib/validate";

const payload: PilotPayload = { business_name: "Пример", city: "Казань", contact_name: "Иван", phone: "+79000000000", email: null, consent: true, website: "" };
const resp = (status: number) => Promise.resolve(new Response("{}", { status })) as Promise<Response>;

describe("classifyStatus", () => {
  it("сопоставляет статусы", () => {
    expect(classifyStatus(201)).toEqual({ ok: true });
    for (const s of [404, 501, 503]) expect(classifyStatus(s)).toEqual({ ok: false, kind: "unavailable" });
    expect(classifyStatus(422)).toEqual({ ok: false, kind: "invalid" });
    expect(classifyStatus(429)).toEqual({ ok: false, kind: "rate" });
    expect(classifyStatus(500)).toEqual({ ok: false, kind: "server" });
  });
});

describe("submitPilot", () => {
  it("отправляет JSON на эндпоинт заявок", async () => {
    const f = vi.fn(() => resp(201));
    const r = await submitPilot(payload, { mode: "live", fetchImpl: f as unknown as typeof fetch });
    expect(r).toEqual({ ok: true });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/autoflow/pilot-requests");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(payload);
  });
  it("404 и 501 — «временно не принимаются»", async () => {
    for (const s of [404, 501]) {
      const r = await submitPilot(payload, { mode: "live", fetchImpl: (() => resp(s)) as unknown as typeof fetch });
      expect(r).toEqual({ ok: false, kind: "unavailable" });
    }
  });
  it("сетевая ошибка не бросает исключение", async () => {
    const r = await submitPilot(payload, { mode: "live", fetchImpl: (() => Promise.reject(new TypeError("down"))) as unknown as typeof fetch });
    expect(r).toEqual({ ok: false, kind: "network" });
  });
  it("mock-режим не использует сеть", async () => {
    const f = vi.fn();
    const r = await submitPilot(payload, { mode: "mock", fetchImpl: f as unknown as typeof fetch });
    expect(r).toEqual({ ok: true });
    expect(f).not.toHaveBeenCalled();
  });
});
