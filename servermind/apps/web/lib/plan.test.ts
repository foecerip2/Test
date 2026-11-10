import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize, computePlanHash, maxRisk, planRisk, sha256Fallback, sha256Hex } from "./plan";
import type { PlanStep } from "./types";

const step = (id: string, over: Partial<PlanStep> = {}): PlanStep => ({
  id, tool: "service.restart", title: "t", params: { unit: "myapp" }, risk: "R2", optional: false, enabled: true,
  expectedChange: "", verify: "", rollback: "", ...over,
});
const plan = (steps: PlanStep[], revision = 1) => ({ id: "plan_1", serverId: "srv_1", revision, steps, expiresAt: "2026-11-09T15:00:00.000Z" });

describe("sha256", () => {
  it("совпадает с эталоном для 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("запасная реализация совпадает с node:crypto на разных длинах (граничные случаи паддинга)", () => {
    for (const len of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const text = "я".repeat(len) + "x".repeat(len % 7);
      const expected = createHash("sha256").update(text).digest("hex");
      expect(sha256Fallback(new TextEncoder().encode(text))).toBe(expected);
    }
  });
});

describe("canonicalize", () => {
  it("не зависит от порядка ключей", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(canonicalize({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 }));
  });
});

describe("computePlanHash", () => {
  it("детерминирован", async () => {
    const p = plan([step("s1")]);
    expect(await computePlanHash(p)).toBe(await computePlanHash(structuredClone(p)));
  });
  it("меняется при смене ревизии, параметров, сервера, срока и набора шагов", async () => {
    const base = await computePlanHash(plan([step("s1"), step("s2", { optional: true })]));
    expect(await computePlanHash(plan([step("s1"), step("s2", { optional: true })], 2))).not.toBe(base);
    expect(await computePlanHash(plan([step("s1", { params: { unit: "other" } }), step("s2", { optional: true })]))).not.toBe(base);
    expect(await computePlanHash({ ...plan([step("s1"), step("s2", { optional: true })]), serverId: "srv_2" })).not.toBe(base);
    expect(await computePlanHash({ ...plan([step("s1"), step("s2", { optional: true })]), expiresAt: "2026-11-09T15:01:00.000Z" })).not.toBe(base);
    expect(await computePlanHash(plan([step("s1"), step("s2", { optional: true, enabled: false })]))).not.toBe(base);
  });
  it("не включает человекочитаемые поля (title, rollback) — только tool/params/risk", async () => {
    const a = await computePlanHash(plan([step("s1", { title: "A", rollback: "x" })]));
    const b = await computePlanHash(plan([step("s1", { title: "B", rollback: "y" })]));
    expect(a).toBe(b);
  });
});

describe("risk", () => {
  it("берёт максимум по включённым шагам", () => {
    expect(maxRisk(["R0", "R3", "R1"])).toBe("R3");
    expect(planRisk({ steps: [step("a", { risk: "R3", enabled: false }), step("b", { risk: "R1" })] })).toBe("R1");
  });
});

// Контракт «браузер ↔ сервер»: те же векторы, что в apps/api/tests/test_plan_hash.py. Если тест упал — подтверждение планов сломано.
describe("общий вектор хеша с backend (Python)", () => {
  it("вектор A: включённые шаги, порядок ключей, выключенный шаг не входит в хеш", async () => {
    const steps: PlanStep[] = [
      step("s1", { tool: "service.restart", params: { unit: "nginx" }, risk: "R2" }),
      step("s2", { tool: "http.healthcheck", params: { url: "http://127.0.0.1:8080/healthz", expect_status: 200, timeout_s: 10 }, risk: "R1", enabled: false }),
    ];
    const h = await computePlanHash({ id: "11111111-1111-4111-8111-111111111111", serverId: "00000000-0000-4000-8000-000000000002", revision: 3, steps, expiresAt: "2026-11-10T04:30:00Z" });
    expect(h).toBe("4f125d2be9ffb9c848b0196481587c57beec87a705bc047e70b4ed59e485c331");
  });
  it("вектор B: Unicode, вложенные объекты, массив с null и булевыми значениями", async () => {
    const steps = [step("s1", { tool: "x.test", params: { k: "Привет", n: [1, true, null], z: { b: 2, a: 1 } } as never, risk: "R0" })];
    const h = await computePlanHash({ id: "p", serverId: "s", revision: 1, steps, expiresAt: "2026-11-10T04:30:00Z" });
    expect(h).toBe("1833a6c2343477a0bb2f27a0709453d54bc46b9c9befcb1983f817be8b48fbcf");
  });
});
