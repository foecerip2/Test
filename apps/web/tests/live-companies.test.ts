import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { createLiveCompanies, filterParams, toCompanyDetail } from "@/lib/api/live-companies";

interface Call { url: string; method: string; headers: Record<string, string>; body: string | undefined; credentials?: RequestCredentials }

/** Подставной fetch: отвечает по очереди заранее заготовленными ответами и записывает вызовы. */
function fake(...responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as string | undefined, credentials: init?.credentials });
    const next = queue.shift();
    if (!next) throw new Error("нет ответа в очереди");
    if (next instanceof Error) throw next;
    return next;
  });
  return { calls, fetchImpl };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const company = (over: Record<string, unknown> = {}) => ({
  id: "c1", name: "Север Авто", city: "Казань", category: "Автосервис", website: "https://sever.example", domain: "sever.example", inn: "7707083893",
  state: "discovered", stage: "new", score: 35, display: { key: "new", label: "Новый", tone: "neutral" }, source_label: "Импорт CSV",
  created_at: "2026-11-10T10:00:00Z", updated_at: "2026-11-10T12:00:00Z", demo: false, duplicate_candidate: false, ...over,
});
const mk = (...r: Array<Response | Error>) => {
  const f = fake(...r);
  const notify = vi.fn();
  const api = createLiveCompanies(f.fetchImpl, () => "csrf-token", notify);
  return { ...f, api, notify };
};

describe("live-companies: список и преобразование полей", () => {
  it("GET /companies: параметры snake_case, cookie, camelCase в ответе", async () => {
    const { api, calls } = mk(json({ items: [company()], total: 128, cities: ["Казань", "Уфа"], has_more: true, next_cursor: "eyJz" }));
    const page = await api.companies.list({ query: " авто ", city: "Казань", scoreMin: 50, status: "new", sort: "name", dir: "asc", limit: 20 });
    const u = new URL(calls[0]!.url, "http://x");
    expect(u.pathname).toBe("/api/v1/companies");
    expect(Object.fromEntries(u.searchParams)).toEqual({ query: "авто", city: "Казань", score_min: "50", status: "new", sort: "name", dir: "asc", limit: "20" });
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.credentials).toBe("same-origin");
    expect(calls[0]!.headers["X-CSRF-Token"]).toBeUndefined();
    expect(page).toMatchObject({ total: 128, cities: ["Казань", "Уфа"], hasMore: true, nextCursor: "eyJz" });
    expect(page.items[0]).toMatchObject({ id: "c1", sourceLabel: "Импорт CSV", updatedAt: "2026-11-10T12:00:00Z", duplicateCandidate: false, demo: false, display: { key: "new", tone: "neutral" } });
  });

  it("пустые фильтры не отправляются, limit ограничен 200", () => {
    expect(filterParams({}, true).toString()).toBe("limit=50");
    expect(filterParams({ limit: 5000, scoreMin: 0, query: "  " }, true).toString()).toBe("limit=200");
    expect(filterParams({ query: "x", limit: 10 }, false).toString()).toBe("query=x");
  });

  it("пагинация по cursor: next_cursor передаётся как есть, последняя страница без курсора", async () => {
    const { api, calls } = mk(
      json({ items: [company({ id: "a" })], total: 2, cities: [], has_more: true, next_cursor: "CUR/1+=" }),
      json({ items: [company({ id: "b" })], total: 2, cities: [], has_more: false, next_cursor: null }),
    );
    const p1 = await api.companies.list({ limit: 1 });
    expect(p1.nextCursor).toBe("CUR/1+=");
    const p2 = await api.companies.list({ limit: 1, cursor: p1.nextCursor! });
    expect(new URL(calls[1]!.url, "http://x").searchParams.get("cursor")).toBe("CUR/1+=");
    expect(p2).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("INVALID_CURSOR: русский текст", async () => {
    const { api } = mk(json({ code: "INVALID_CURSOR", message: "bad" }, 422));
    await expect(api.companies.list({ cursor: "bad" })).rejects.toMatchObject({ status: 422, code: "INVALID_CURSOR", message: "Список устарел. Обновите страницу списка." });
  });

  it("GET /companies/{id}: карточка, факты, разбор оценки, история; контакты и черновик — заглушки", async () => {
    const { api, calls } = mk(json({
      ...company(), note: "позвонить", score_version: "rules-v1",
      facts: [{ id: "f1", text: "Есть запись", kind: "confirmed", evidence_url: "https://x.example/a", evidence_excerpt: "«запись»", observed_at: "2026-11-10T10:00:00Z", confidence: 0.9 }],
      score_reasons: [{ rule: "business_type", label: "Тип бизнеса", points: 25, max: 25, note: "Автосервис" }],
      history: [{ id: "h1", event_type: "company.imported", icon: "download", title: "Импортирована из CSV", text: "Строка 2", at: "2026-11-10T10:00:00Z", company_id: "c1", company_name: null }],
      contacts: [{ weird: true }], draft_id: "ignored",
    }));
    const d = await api.companies.get("c 1/2");
    expect(calls[0]!.url).toBe("/api/v1/companies/c%201%2F2");
    expect(d.note).toBe("позвонить");
    expect(d.scoreVersion).toBe("rules-v1");
    expect(d.facts[0]).toMatchObject({ kind: "confirmed", evidenceUrl: "https://x.example/a", evidenceExcerpt: "«запись»", observedAt: "2026-11-10T10:00:00Z", confidence: 0.9 });
    expect(d.scoreReasons[0]).toMatchObject({ rule: "business_type", points: 25, max: 25 });
    expect(d.history[0]).toMatchObject({ id: "h1", companyId: "c1", icon: "download" });
    expect(d.contacts).toEqual([]);
    expect(d.draftId).toBeNull();
  });

  it("неполный ответ не ломает преобразование", () => {
    const d = toCompanyDetail({ id: "z" });
    expect(d).toMatchObject({ id: "z", name: "", stage: "new", state: "discovered", score: 0, facts: [], history: [] });
  });
});

describe("live-companies: изменения, CSRF, оптимистичная проверка стадии", () => {
  it("PATCH stage + expected_stage, заголовок CSRF, уведомление подписчиков", async () => {
    const { api, calls, notify } = mk(json(company({ stage: "contacted" })));
    await api.companies.setStage("c1", "contacted", "new");
    expect(calls[0]).toMatchObject({ url: "/api/v1/companies/c1", method: "PATCH" });
    expect(calls[0]!.headers["X-CSRF-Token"]).toBe("csrf-token");
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ stage: "contacted", expected_stage: "new" });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("без expected стадия уходит одна", async () => {
    const { api, calls } = mk(json(company()));
    await api.companies.setStage("c1", "pilot");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ stage: "pilot" });
  });

  it("409 STAGE_CONFLICT: русский текст, текущая стадия, подписчики уведомлены для обновления", async () => {
    const { api, notify } = mk(json({ code: "STAGE_CONFLICT", message: "Stage was changed", current_stage: "replied", request_id: "r1" }, 409));
    const err = await api.companies.setStage("c1", "contacted", "new").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: "STAGE_CONFLICT", details: { currentStage: "replied", requestId: "r1" } });
    expect(err.message).toMatch(/Стадию уже изменили.*обновлены/);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("409 SUPPRESSION_PERMANENT: понятный русский текст", async () => {
    const { api } = mk(json({ code: "SUPPRESSION_PERMANENT", message: "x" }, 409));
    const err = await api.companies.setStage("c1", "new", "lost").catch((e) => e);
    expect(err.code).toBe("SUPPRESSION_PERMANENT");
    expect(err.message).toMatch(/отказ/);
  });

  it("заметка и отклонение: PATCH {note} и POST /reject с CSRF", async () => {
    const { api, calls } = mk(json(company()), json(company({ state: "rejected" })));
    await api.companies.setNote("c1", "текст");
    await api.companies.reject("c1");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ note: "текст" });
    expect(calls[1]).toMatchObject({ url: "/api/v1/companies/c1/reject", method: "POST" });
    expect(calls[1]!.headers["X-CSRF-Token"]).toBe("csrf-token");
  });

  it("сетевой сбой и ответ не JSON: понятные сообщения", async () => {
    const net = mk(new TypeError("failed"));
    await expect(net.api.companies.get("c1")).rejects.toMatchObject({ status: 0, code: "NETWORK", message: "Нет соединения с сервером." });
    const bad = mk(new Response("<html>Bad gateway</html>", { status: 502 }));
    await expect(bad.api.companies.get("c1")).rejects.toMatchObject({ status: 502, message: "Сервер временно недоступен. Попробуйте позже." });
  });

  it("404 и 401: русские тексты", async () => {
    const a = mk(json({ code: "NOT_FOUND", message: "Company not found" }, 404));
    await expect(a.api.companies.get("zzz")).rejects.toMatchObject({ code: "NOT_FOUND", message: "Компания не найдена." });
    const b = mk(json({ code: "UNAUTHENTICATED", message: "x" }, 401));
    await expect(b.api.summary()).rejects.toMatchObject({ status: 401, message: "Сессия истекла. Войдите снова." });
  });
});

describe("live-companies: экспорт", () => {
  it("GET /companies/export с теми же фильтрами, без limit/cursor; добавляет BOM", async () => {
    const { api, calls } = mk(new Response('"Компания";"Город"\r\n"Север";"Казань"\r\n', { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8" } }));
    const csv = await api.companies.exportCsv({ query: "авто", status: "new", limit: 10, cursor: "x" });
    const u = new URL(calls[0]!.url, "http://x");
    expect(u.pathname).toBe("/api/v1/companies/export");
    expect(Object.fromEntries(u.searchParams)).toEqual({ query: "авто", status: "new" });
    expect(calls[0]!.headers.Accept).toBe("text/csv");
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("Север");
  });
});

describe("live-companies: импорт", () => {
  const dry = {
    dry_run: true, missing_columns: [],
    rows: [
      { line: 2, name: "Север Авто", city: "Казань", category: "Автосервис", website: "sever.example", inn: null, issues: [], duplicate: null },
      { line: 3, name: "", city: "Уфа", category: "СТО", website: null, inn: null, issues: ["Нет названия"], duplicate: null },
      { line: 4, name: "Дубль", city: "Казань", category: "СТО", website: null, inn: "7707083893", issues: [], duplicate: { kind: "exact", of: "Север Авто" } },
    ],
    summary: { total: 3, importable: 1, with_issues: 1, exact: 1, in_file: 0, candidates: 0 },
  };

  it("preview: dry_run=true, тело — текст CSV, строки и summary в camelCase", async () => {
    const { api, calls } = mk(json(dry));
    const text = "название;город\nСевер Авто;Казань\n";
    const p = await api.imports.preview(text);
    expect(calls[0]).toMatchObject({ url: "/api/v1/imports/companies?dry_run=true", method: "POST", body: text });
    expect(calls[0]!.headers["Content-Type"]).toBe("text/csv; charset=utf-8");
    expect(calls[0]!.headers["X-CSRF-Token"]).toBe("csrf-token");
    expect(p.summary).toEqual({ total: 3, importable: 1, withIssues: 1, exact: 1, inFile: 0, candidates: 0 });
    expect(p.rows[1]!.issues).toEqual(["Нет названия"]);
    expect(p.rows[2]!.duplicate).toEqual({ kind: "exact", of: "Север Авто" });
    expect(p.missingColumns).toEqual([]);
  });

  it("preview: missing_columns приходят со статусом 200", async () => {
    const { api } = mk(json({ dry_run: true, rows: [], missing_columns: ["город"], summary: { total: 0, importable: 0, with_issues: 0, exact: 0, in_file: 0, candidates: 0 } }));
    expect((await api.imports.preview("название\nА\n")).missingColumns).toEqual(["город"]);
  });

  it("commit: dry_run=false с тем же текстом, итоги и уведомление подписчиков", async () => {
    const { api, calls, notify } = mk(json({ dry_run: false, job_id: "j1", rows_total: 3, added: 1, skipped: 2, candidates: 0, summary: dry.summary }));
    const text = "название;город\nСевер Авто;Казань\n";
    const r = await api.imports.commit(text);
    expect(calls[0]).toMatchObject({ url: "/api/v1/imports/companies?dry_run=false", method: "POST", body: text });
    expect(r).toMatchObject({ jobId: "j1", rowsTotal: 3, added: 1, skipped: 2, candidates: 0 });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it.each([
    [413, "PAYLOAD_TOO_LARGE", /2 МБ/],
    [422, "TOO_MANY_ROWS", /5000 строк/],
    [422, "EMPTY_FILE", /нет строк/],
    [422, "INVALID_ENCODING", /UTF-8/],
    [415, "UNSUPPORTED_MEDIA_TYPE", /CSV/],
    [409, "IMPORT_CONFLICT", /Повторите/],
  ])("ошибка %i %s — русский текст", async (status, code, re) => {
    const { api, notify } = mk(json({ code, message: "english message" }, status));
    const err = await api.imports.commit("x").catch((e) => e);
    expect(err).toMatchObject({ status, code });
    expect(err.message).toMatch(re);
    expect(notify).not.toHaveBeenCalled();
  });

  it("MISSING_COLUMNS на commit: перечисляет колонки", async () => {
    const { api } = mk(json({ code: "MISSING_COLUMNS", message: "…", missing_columns: ["название", "город"] }, 422));
    const err = await api.imports.commit("x").catch((e) => e);
    expect(err.message).toBe("В файле нет обязательных колонок: название, город.");
    expect(err.details.missingColumns).toEqual(["название", "город"]);
  });

  it("413 без JSON-тела (ответ прокси) тоже даёт понятный текст", async () => {
    const { api } = mk(new Response("Request Entity Too Large", { status: 413 }));
    await expect(api.imports.preview("x")).rejects.toMatchObject({ status: 413, code: "PAYLOAD_TOO_LARGE" });
  });
});

describe("live-companies: сводка /dashboard", () => {
  it("snake_case → Summary без выдуманных показателей", async () => {
    const { api, calls } = mk(json({
      companies_total: 128, companies_week: 12, suitable: 9, score_threshold: 75,
      by_stage: { new: 100, contacted: 20, replied: 4, interested: 2, pilot: 1, lost: 1 }, by_state: { discovered: 120 },
      top_companies: [company()], recent: [{ id: "e1", event_type: "company.imported", icon: "download", title: "Импортирована из CSV", text: "Строка 2", at: "2026-11-10T10:00:00Z", company_id: "c1", company_name: "Север Авто" }],
    }));
    const s = await api.summary();
    expect(calls[0]!.url).toBe("/api/v1/dashboard");
    expect(s).toMatchObject({ companiesTotal: 128, companiesWeek: 12, suitable: 9, scoreThreshold: 75, byStage: { new: 100, lost: 1 } });
    expect(s.topCompanies[0]!.name).toBe("Север Авто");
    expect(s.recent[0]).toMatchObject({ companyId: "c1", companyName: "Север Авто" });
    // Показатели, которых нет на сервере, остаются неопределёнными — UI их скрывает, а не рисует нули.
    expect(s.awaitingApproval).toBeUndefined();
    expect(s.funnel).toBeUndefined();
    expect(s.weekly).toBeUndefined();
    expect(s.quality).toBeUndefined();
    expect(s.attention).toEqual([]);
  });
});
