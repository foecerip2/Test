import { describe, expect, it } from "vitest";
import { scoreCompany, type ScoreInput } from "@/lib/scoring";
import { classifyReply } from "@/lib/classify";

const full: ScoreInput = { businessType: "autoservice", demandSignals: 3, siteWorks: true, onlineBookingDetected: false, hasBusinessContact: true, isDuplicate: false, hasRefusal: false };

describe("scoreCompany", () => {
  it("максимум 100 и веса 25/20/15/15/15/10", () => {
    const r = scoreCompany(full);
    expect(r.score).toBe(100);
    expect(r.reasons.map((x) => x.max)).toEqual([25, 20, 15, 15, 15, 10]);
  });
  it("границы 0..100", () => {
    const zero = scoreCompany({ businessType: "other", demandSignals: 0, siteWorks: false, onlineBookingDetected: null, hasBusinessContact: false, isDuplicate: true, hasRefusal: true });
    expect(zero.score).toBe(0);
    expect(scoreCompany({ ...full, demandSignals: 99 }).score).toBe(100);
  });
  it("отсутствие онлайн-записи «не проверялось» не даёт баллов и не равно «нет»", () => {
    const r = scoreCompany({ ...full, onlineBookingDetected: null });
    expect(r.reasons.find((x) => x.rule === "booking")!.points).toBe(0);
    expect(r.reasons.find((x) => x.rule === "booking")!.note).toMatch(/не проверялось/i);
  });
  it("отказ или дубликат снимают 10 баллов", () => {
    expect(scoreCompany({ ...full, hasRefusal: true }).score).toBe(90);
    expect(scoreCompany({ ...full, isDuplicate: true }).score).toBe(90);
  });
  it("каждая причина объяснима", () => {
    for (const r of scoreCompany(full).reasons) expect(r.note.length).toBeGreaterThan(0);
  });
});

describe("classifyReply", () => {
  it("отписка приоритетнее остального", () => {
    expect(classifyReply("Не актуально, просим больше не писать").label).toBe("unsubscribe");
  });
  it("классы", () => {
    expect(classifyReply("Да, интересно, сколько стоит?").label).toBe("interested");
    expect(classifyReply("У вас есть интеграция с CRM?").label).toBe("question");
    expect(classifyReply("Давайте позже").label).toBe("later");
    expect(classifyReply("ок").label).toBe("ambiguous");
  });
  it("правила — низкая уверенность для неясных", () => {
    expect(classifyReply("ок").confidence).toBeLessThan(0.5);
  });
});

describe("classifyReply: отрицания", () => {
  it("«не присылайте» — отписка, а не интерес", () => {
    expect(classifyReply("Не присылайте нам больше предложений").label).toBe("unsubscribe");
    expect(classifyReply("Уберите нас из рассылки").label).toBe("unsubscribe");
    expect(classifyReply("Присылайте, посмотрим").label).toBe("interested");
  });
});
