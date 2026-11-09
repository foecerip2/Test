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
