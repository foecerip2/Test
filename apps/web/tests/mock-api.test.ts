import { beforeEach, describe, expect, it } from "vitest";
import { ApiError, type Api } from "@/lib/api";
import { createMockApi } from "@/lib/api/mock";

let api: Api;
beforeEach(() => { api = createMockApi(); });

async function firstDraftWithEmail() {
  const ds = await api.drafts.list();
  const d = ds.find((x) => x.companyName.startsWith("ТестАвто"))!;
  return d;
}

describe("серверные правила отправки (mock = контракт FastAPI)", () => {
  it("по умолчанию отправка заблокирована: аварийный стоп, текст не согласован", async () => {
    const d = await firstDraftWithEmail();
    const p = await api.outbox.preview(d.id);
    expect(p.canSend).toBe(false);
    expect(p.reasonCodes).toEqual(expect.arrayContaining(["EMERGENCY_STOP", "TEXT_NOT_APPROVED"]));
    await expect(api.outbox.send(d.id)).rejects.toMatchObject({ status: 403, code: "SEND_BLOCKED" });
  });

  it("без согласия адресата отправка запрещена даже при одобренном тексте и снятом стопе", async () => {
    await api.settings.patch({ emergencyStopSend: false });
    const ds = await api.drafts.list();
    const d = ds.find((x) => x.companyName.includes("Северный мотор"))!;
    await api.drafts.approve(d.id, d.version);
    const p = await api.outbox.preview(d.id);
    expect(p.ownerApproved).toBe(true);
    expect(p.reasonCodes).toContain("CONSENT_NOT_VERIFIED");
    expect(p.canSend).toBe(false);
    await expect(api.outbox.send(d.id)).rejects.toBeInstanceOf(ApiError);
  });

  it("с проверенным согласием, одобренным текстом и снятым стопом — только тогда можно (в демо — очередь без реальной отправки)", async () => {
    const d = await firstDraftWithEmail();
    await api.settings.patch({ emergencyStopSend: false });
    await api.drafts.approve(d.id, d.version);
    const p = await api.outbox.preview(d.id);
    expect(p.canSend).toBe(true);
    await expect(api.outbox.send(d.id)).resolves.toEqual({ status: "queued_demo" });
  });

  it("правка текста после согласования делает одобрение устаревшим (APPROVAL_STALE)", async () => {
    const d = await firstDraftWithEmail();
    await api.settings.patch({ emergencyStopSend: false });
    const approved = await api.drafts.approve(d.id, d.version);
    const edited = await api.drafts.update(d.id, { body: approved.body + " Изменение." }, approved.version);
    expect(edited.status).toBe("pending_review");
    expect(edited.approvalStale).toBe(true);
    const p = await api.outbox.preview(d.id);
    expect(p.canSend).toBe(false);
    expect(p.reasonCodes).toContain("APPROVAL_STALE");
  });

  it("optimistic lock: устаревшая версия → 409", async () => {
    const d = await firstDraftWithEmail();
    await api.drafts.update(d.id, { body: "Новый текст" }, d.version);
    await expect(api.drafts.update(d.id, { body: "Ещё" }, d.version)).rejects.toMatchObject({ status: 409, code: "VERSION_CONFLICT" });
    await expect(api.drafts.approve(d.id, d.version)).rejects.toMatchObject({ status: 409 });
  });

  it("неподдерживаемый канал не отправляется автоматически", async () => {
    const ds = await api.drafts.list();
    const d = ds.find((x) => x.companyName.includes("Северный мотор"))!;
    await api.drafts.update(d.id, { channel: "telegram" }, d.version);
    const p = await api.outbox.preview(d.id);
    expect(p.canSend).toBe(false);
  });
});

describe("отписка и подавление", () => {
  it("отписка необратима и блокирует отправку", async () => {
    const convs = await api.conversations.list();
    const v = convs.find((c) => c.companyName.includes("МоторЛайн"))!;
    await api.conversations.classify(v.id, "unsubscribe");
    await expect(api.conversations.classify(v.id, "interested")).rejects.toMatchObject({ status: 409, code: "SUPPRESSION_PERMANENT" });
    const sup = await api.suppression();
    expect(sup.some((s) => s.endpointMasked.includes("motorline"))).toBe(true);
  });

  it("согласие не снимает подавление", async () => {
    const co = (await api.companies.list({ query: "АвтоПрофи" })).items[0]!;
    const det = await api.companies.get(co.id);
    const contact = det.contacts[0]!;
    expect(contact.suppressed).toBe(true);
    await expect(api.consents.record(contact.id, { proofType: "x", proofRef: "y" })).rejects.toMatchObject({ code: "SUPPRESSED" });
  });
});

describe("импорт", () => {
  it("dry-run ничего не пишет, commit добавляет и пропускает точные дубли", async () => {
    const before = (await api.companies.list({})).total;
    const csv = "название;город;сайт\nНовый сервис;Тверь;new-service.example\nСТО «Северный мотор»;Санкт-Петербург;sever-motor.example\n";
    const prev = await api.imports.preview(csv);
    expect((await api.companies.list({})).total).toBe(before);
    expect(prev.rows[1]!.duplicate?.kind).toBe("exact");
    const res = await api.imports.commit(prev.rows);
    expect(res).toEqual({ added: 1, skipped: 1 });
    expect((await api.companies.list({})).total).toBe(before + 1);
  });
});

describe("режим пустых данных", () => {
  it("empty: нули без выдуманных метрик", async () => {
    const e = createMockApi({ empty: true });
    const s = await e.summary();
    expect(s.companiesTotal).toBe(0);
    expect(s.funnel.every((f) => f.count === 0)).toBe(true);
  });
});

describe("замечания ревью: инварианты", () => {
  it("отклонённый черновик нельзя согласовать или править", async () => {
    const d = (await api.drafts.list())[0]!;
    await api.drafts.reject(d.id);
    await expect(api.drafts.approve(d.id, d.version)).rejects.toMatchObject({ status: 409, code: "INVALID_STATE" });
    await expect(api.drafts.update(d.id, { body: "x" }, d.version)).rejects.toMatchObject({ status: 409, code: "INVALID_STATE" });
  });

  it("повторная отправка заблокирована (идемпотентность)", async () => {
    const d = (await api.drafts.list()).find((x) => x.companyName.startsWith("ТестАвто"))!;
    await api.settings.patch({ emergencyStopSend: false });
    await api.drafts.approve(d.id, d.version);
    await api.outbox.send(d.id);
    await expect(api.outbox.send(d.id)).rejects.toMatchObject({ status: 403 });
    expect((await api.outbox.preview(d.id)).reasonCodes).toContain("ALREADY_QUEUED");
  });

  it("ИНН сохраняется при импорте и дедуплицирует следующий импорт", async () => {
    const first = await api.imports.preview("название;город;инн\nНовая;Тверь;7707083893\n");
    await api.imports.commit(first.rows);
    const second = await api.imports.preview("название;город;инн\nДругая;Казань;7707083893\n");
    expect(second.rows[0]!.duplicate?.kind).toBe("exact");
  });

  it("импортированная компания не получает непроверенных баллов", async () => {
    const prev = await api.imports.preview("название;город;сайт;категория\nСтоматология Х;Тверь;x.example;Стоматология\n");
    await api.imports.commit(prev.rows);
    const c = (await api.companies.list({ query: "Стоматология" })).items[0]!;
    const det = await api.companies.get(c.id);
    expect(det.score).toBeLessThan(25);
    expect(det.scoreReasons.find((r) => r.rule === "site")!.points).toBe(0);
  });

  it("commit не доверяет клиенту: подделанные issues/duplicate перепроверяются", async () => {
    const forged = [{ line: 2, name: "", city: "Тверь", category: "Автосервис", website: null, inn: null, issues: [], duplicate: null }];
    expect(await api.imports.commit(forged)).toEqual({ added: 0, skipped: 1 });
  });

  it("settings.patch: только разрешённые поля и серверная валидация", async () => {
    await api.settings.patch({ aiSpentTodayRub: 999 } as never);
    expect((await api.settings.get()).aiSpentTodayRub).toBe(0);
    await expect(api.settings.patch({ retentionDays: -5 })).rejects.toMatchObject({ status: 422 });
    await expect(api.settings.patch({ aiDailyBudgetRub: 500, aiMonthlyBudgetRub: 100 })).rejects.toMatchObject({ status: 422 });
    await expect(api.settings.patch({ aiMode: "evil" as never })).rejects.toMatchObject({ status: 422 });
  });

  it("стадию отписавшейся компании нельзя вернуть", async () => {
    const co = (await api.companies.list({ query: "АвтоПрофи" })).items[0]!;
    await expect(api.companies.setStage(co.id, "new")).rejects.toMatchObject({ status: 409, code: "SUPPRESSION_PERMANENT" });
  });
});
