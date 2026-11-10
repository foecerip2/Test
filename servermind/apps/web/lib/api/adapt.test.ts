import { describe, expect, it } from "vitest";
import { adaptJob } from "@/lib/api";

const base = {
  id: "j1", planId: "p1", serverId: "s1", serverName: "web-1", title: "Репетиция: Перезапуск nginx", risk: "R2" as const, actor: "owner",
  summary: "Репетиция пройдена: 2 шаг(ов). Реальное исполнение выключено, на сервере ничего не выполнялось.",
  createdAt: "2026-11-10T08:00:00.000000Z", startedAt: "2026-11-10T08:00:01.000000Z", finishedAt: "2026-11-10T08:00:02.000000Z",
};

describe("adaptJob (ответ исполнителя → Operation)", () => {
  it("успешная репетиция: режим, счётчики, команда помечена как невыполненная", () => {
    const op = adaptJob({
      ...base, status: "succeeded", stepsDone: 1, stepsTotal: 1,
      steps: [{ order: 1, stepId: "s1", tool: "service.restart", status: "rehearsed", checks: [{ name: "policy", ok: true, detail: "ok" }],
        plannedAction: "sudo -n /usr/local/sbin/servermind-op service.restart '{\"unit\":\"nginx\"}'", at: base.startedAt }],
    });
    expect(op.mode).toBe("rehearsal");
    expect(op.status).toBe("succeeded");
    expect([op.stepsDone, op.stepsTotal]).toEqual([1, 1]);
    expect(op.events.some((e) => e.message.includes("не выполнялось") && e.message.includes("servermind-op"))).toBe(true);
    expect(new Set(op.events.map((e) => e.id)).size).toBe(op.events.length);
  });

  it("остановка проверкой: статус blocked, причина попадает в журнал как ошибка", () => {
    const op = adaptJob({
      ...base, status: "blocked", summary: "Репетиция остановлена: Хеш не совпал.", stepsDone: 0, stepsTotal: 2,
      steps: [
        { order: 1, stepId: "s1", tool: "service.restart", status: "blocked", checks: [{ name: "hash_integrity", ok: false, detail: "Содержимое плана не соответствует хешу" }], plannedAction: "", at: base.startedAt },
        { order: 2, stepId: "s2", tool: "http.healthcheck", status: "skipped", checks: [], plannedAction: "", at: base.startedAt },
      ],
    });
    expect(op.status).toBe("blocked");
    expect(op.events.filter((e) => e.level === "error").some((e) => e.message.includes("hash_integrity"))).toBe(true);
    expect(op.events.find((e) => e.message.includes("пропущен"))?.level).toBe("warn");
  });

  it("реальное исполнение: режим execute, ответ сервера и отправленная команда в журнале", () => {
    const op = adaptJob({
      ...base, mode: "execute", status: "failed", stepsDone: 1, stepsTotal: 2, summary: "Исполнено шагов: 1 из 2.",
      steps: [
        { order: 1, stepId: "s1", tool: "service.restart", status: "executed", checks: [], plannedAction: "sudo -n /usr/local/sbin/servermind-op service.restart '{}'", output: "nginx.service: active", at: base.startedAt },
        { order: 2, stepId: "s2", tool: "http.healthcheck", status: "failed", checks: [], plannedAction: "sudo -n /usr/local/sbin/servermind-op http.healthcheck '{}'", output: "HTTP 503, ожидалось 200", at: base.startedAt },
      ],
    });
    expect(op.mode).toBe("execute");
    const text = op.events.map((e) => e.message).join("\n");
    expect(text).toContain("Отправлено на сервер:");
    expect(text).not.toContain("не выполнялось");
    expect(op.events.find((e) => e.message.includes("nginx.service: active"))?.level).toBe("info");
    expect(op.events.find((e) => e.message.includes("HTTP 503"))?.level).toBe("error");
    expect(op.events[0]?.level).toBe("warn"); // постановка реального исполнения выделена как предупреждение
  });

  it("список без шагов не падает", () => {
    expect(adaptJob({ ...base, status: "queued", finishedAt: null, startedAt: null, stepsDone: 0, stepsTotal: 1 }).events).toHaveLength(1);
  });
});
