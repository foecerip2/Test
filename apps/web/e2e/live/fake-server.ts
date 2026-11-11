/**
 * Подставной сервер для e2e в live-режиме: подменяет /api/v1/* через route, отвечая в формате РЕАЛЬНОГО бэкенда
 * (apps/api: company_schemas.py, routers/companies.py, imports.py, dashboard.py; коды ошибок — docs/API.md).
 * Состояние живёт в памяти одного теста: вход, база компаний, импорт, стадии, заметки.
 */
import type { Page, Route } from "@playwright/test";

export type Stage = "new" | "contacted" | "replied" | "interested" | "pilot" | "lost";
interface Co {
  id: string; name: string; city: string; category: string; website: string | null; domain: string | null; inn: string | null;
  state: string; stage: Stage; score: number; source_label: string; created_at: string; updated_at: string; note: string; duplicate_candidate: boolean;
}
export interface Req { method: string; path: string; query: URLSearchParams; headers: Record<string, string>; body: string | null }
export interface FakeOptions {
  /** Начальные компании (по умолчанию база пуста — как на рабочем сервере). */
  companies?: number | Array<Partial<Co> & { name: string; city: string }>;
  loggedIn?: boolean;
  role?: "owner" | "user";
  /** Принудительный ответ на следующий вызов: "METHOD /path" → ответ. */
  failNext?: Record<string, { status: number; body: Record<string, unknown> }>;
}

export const CSRF = "csrf-e2e";
const iso = (offsetMin = 0) => new Date(Date.UTC(2026, 10, 10, 12, 0, 0) + offsetMin * 60_000).toISOString().replace(".000Z", "Z");
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

const LABEL: Record<string, string> = { new: "Новый", contacted: "Контакт установлен", replied: "Ответила", interested: "Заинтересован", pilot: "Пилот" };
const display = (c: Co) =>
  c.stage === "lost" ? { key: "refused", label: "Отказ", tone: "red" }
    : c.state === "rejected" ? { key: "rejected", label: "Отклонена", tone: "red" }
    : { key: c.stage, label: LABEL[c.stage], tone: c.stage === "pilot" || c.stage === "interested" ? "green" : "neutral" };

const out = (c: Co) => ({
  id: c.id, name: c.name, city: c.city, category: c.category, website: c.website, domain: c.domain, inn: c.inn, state: c.state, stage: c.stage,
  score: c.score, display: display(c), source_label: c.source_label, created_at: c.created_at, updated_at: c.updated_at, demo: false, duplicate_candidate: c.duplicate_candidate,
});

function reasons(c: Co) {
  const auto = c.score >= 35;
  return [
    { rule: "business_type", label: "Тип бизнеса", points: auto ? 25 : 0, max: 25, note: auto ? "Автосервис / СТО" : "Другой тип бизнеса" },
    { rule: "demand", label: "Признаки спроса", points: 0, max: 20, note: "Не проверялось" },
    { rule: "site", label: "Рабочий сайт", points: 0, max: 15, note: "Сайт не проверялся" },
    { rule: "booking", label: "Онлайн-запись", points: 0, max: 15, note: "Не проверялась" },
    { rule: "contact", label: "Деловой контакт", points: 0, max: 15, note: "Контактов нет" },
    { rule: "clean", label: "Чистота", points: Math.min(10, c.score - (auto ? 25 : 0)), max: 10, note: "Нет дублей и отказов" },
  ];
}

const detail = (c: Co) => ({
  ...out(c), note: c.note, facts: [], score_reasons: reasons(c), score_version: "rules-v1",
  history: [{ id: uuid(), event_type: "company.imported", icon: "download", title: "Импортирована из CSV", text: "Строка 2", at: c.created_at, company_id: c.id, company_name: null }],
  contacts: [], draft_id: null,
});

/** Минимальный разбор CSV как на сервере: разделитель ; , или TAB, BOM. */
function parseCsv(text: string): string[][] {
  const t = text.replace(/^﻿/, "");
  const first = t.split(/\r?\n/)[0] ?? "";
  const sep = [";", "\t", ","].map((s) => [s, first.split(s).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  return t.split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => l.split(sep).map((x) => x.trim()));
}
const HEAD: Record<string, string[]> = { name: ["название", "name", "компания"], city: ["город", "city"], category: ["категория", "category"], site: ["сайт", "website", "url"], inn: ["инн", "inn"] };
const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/g, " ").trim();

interface PlanRow { line: number; name: string; city: string; category: string; website: string | null; inn: string | null; issues: string[]; duplicate: { kind: string; of: string } | null }

export class FakeServer {
  companies: Co[] = [];
  loggedIn: boolean;
  role: "owner" | "user";
  requests: Req[] = [];
  failNext: NonNullable<FakeOptions["failNext"]>;
  constructor(o: FakeOptions) {
    this.loggedIn = o.loggedIn ?? false;
    this.role = o.role ?? "owner";
    this.failNext = { ...(o.failNext ?? {}) };
    const seed = typeof o.companies === "number" ? Array.from({ length: o.companies }, (_, i) => ({ name: `Компания ${String(i + 1).padStart(3, "0")}`, city: i % 2 ? "Казань" : "Уфа", score: 100 - (i % 90) })) : o.companies ?? [];
    for (const s of seed) this.add(s);
  }
  add(s: Partial<Co> & { name: string; city: string }) {
    const n = this.companies.length;
    this.companies.push({
      id: uuid(), category: "Автосервис", website: null, domain: null, inn: null, state: "discovered", stage: "new", score: 35, source_label: "Импорт CSV",
      created_at: iso(-n), updated_at: iso(-n), note: "", duplicate_candidate: false, ...s,
    });
  }
  find(name: string) { return this.companies.find((c) => c.name === name)!; }
  /** Меняет стадию «за спиной» клиента (как будто это сделал другой пользователь). */
  setStageBehind(name: string, stage: Stage) { this.find(name).stage = stage; }
  called(method: string, pathPrefix: string) { return this.requests.filter((r) => r.method === method && r.path.startsWith(pathPrefix)); }

  private plan(table: string[][]): { rows: PlanRow[]; missing: string[] } {
    const head = (table[0] ?? []).map(norm);
    const col = (k: string) => head.findIndex((h) => HEAD[k]!.includes(h));
    const c = { name: col("name"), city: col("city"), category: col("category"), site: col("site"), inn: col("inn") };
    const missing = [c.name < 0 ? "название" : "", c.city < 0 ? "город" : ""].filter(Boolean);
    if (missing.length) return { rows: [], missing };
    const seen = new Map<string, string>();
    const rows = table.slice(1).map((cells, i): PlanRow => {
      const get = (k: number) => (k >= 0 ? cells[k] ?? "" : "");
      const name = get(c.name), city = get(c.city);
      const issues: string[] = [];
      if (!name) issues.push("Нет названия");
      if (!city) issues.push("Нет города");
      const key = `${norm(name)}|${norm(city)}`;
      let duplicate: PlanRow["duplicate"] = null;
      const ex = this.companies.find((x) => `${norm(x.name)}|${norm(x.city)}` === key);
      if (!issues.length && ex) duplicate = { kind: "exact", of: ex.name };
      else if (!issues.length && seen.has(key)) duplicate = { kind: "in_file", of: seen.get(key)! };
      if (!issues.length && !seen.has(key)) seen.set(key, name);
      return { line: i + 2, name, city, category: get(c.category) || "Автосервис", website: get(c.site) || null, inn: get(c.inn) || null, issues, duplicate };
    });
    return { rows, missing };
  }
  private summary(rows: PlanRow[]) {
    const imp = (r: PlanRow) => !r.issues.length && !r.duplicate;
    return {
      total: rows.length, importable: rows.filter(imp).length, with_issues: rows.filter((r) => r.issues.length).length,
      exact: rows.filter((r) => r.duplicate?.kind === "exact").length, in_file: rows.filter((r) => r.duplicate?.kind === "in_file").length, candidates: 0,
    };
  }

  async handle(route: Route) {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const method = req.method();
    const headers = req.headers();
    this.requests.push({ method, path, query: url.searchParams, headers, body: req.postData() });
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    const err = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
      json(status, { code, message, request_id: "req-e2e", ...extra });

    const forced = this.failNext[`${method} ${path}`];
    if (forced) { delete this.failNext[`${method} ${path}`]; return json(forced.status, forced.body); }

    const user = { id: "u-owner", email: "owner@example.com", role: this.role, status: "active" };
    // ---- вход ----
    if (path === "/auth/me") return this.loggedIn ? json(200, { user }) : err(401, "UNAUTHENTICATED", "Требуется вход.");
    if (path === "/auth/otp/request") return json(200, { challenge_id: "ch-1", expires_in: 600, resend_in: 60 });
    if (path === "/auth/otp/verify") { this.loggedIn = true; return json(200, { user, is_new: false }); }
    if (path === "/auth/logout") { this.loggedIn = false; return route.fulfill({ status: 204 }); }
    if (!this.loggedIn) return err(401, "UNAUTHENTICATED", "Требуется вход.");
    if (path === "/admin/users") return json(200, { users: [{ id: user.id, email: user.email, role: user.role, status: "active", created_at: iso(-9000), last_login_at: iso(-5) }] });

    // мутации требуют CSRF (как require_active_user_csrf)
    if (method !== "GET" && headers["x-csrf-token"] !== CSRF) return err(403, "CSRF_FAILED", "Неверный CSRF-токен.");

    // ---- дашборд ----
    if (path === "/dashboard" && method === "GET") {
      const live = this.companies;
      const by_stage = Object.fromEntries((["new", "contacted", "replied", "interested", "pilot", "lost"] as Stage[]).map((s) => [s, live.filter((c) => c.stage === s).length]));
      const active = live.filter((c) => c.state !== "rejected" && c.stage !== "lost").sort((a, b) => b.score - a.score);
      return json(200, {
        companies_total: live.length, companies_week: live.length, suitable: active.filter((c) => c.score >= 75).length, score_threshold: 75,
        by_stage, by_state: { discovered: live.length, verified: 0, scored: 0, shortlisted: 0, rejected: live.filter((c) => c.state === "rejected").length, archived: 0 },
        top_companies: active.slice(0, 4).map(out),
        recent: live.slice(0, 5).map((c) => ({ id: uuid(), event_type: "company.imported", icon: "download", title: "Импортирована из CSV", text: "Строка 2", at: c.created_at, company_id: c.id, company_name: c.name })),
      });
    }

    // ---- компании ----
    if (path === "/companies/export" && method === "GET") {
      const lines = '"Компания";"Город"\r\n' + this.companies.map((c) => `"${c.name}";"${c.city}"`).join("\r\n") + "\r\n";
      return route.fulfill({ status: 200, contentType: "text/csv; charset=utf-8", headers: { "Content-Disposition": 'attachment; filename="companies.csv"' }, body: lines });
    }
    if (path === "/companies" && method === "GET") {
      const q = url.searchParams;
      const query = norm(q.get("query") ?? "");
      const sort = q.get("sort") ?? "score";
      const dir = q.get("dir") ?? (sort === "name" ? "asc" : "desc");
      let items = this.companies.filter((c) =>
        (!query || norm(`${c.name} ${c.city} ${c.category} ${c.domain ?? ""}`).includes(query)) &&
        (!q.get("city") || c.city === q.get("city")) && (!q.get("score_min") || c.score >= Number(q.get("score_min"))) && (!q.get("status") || display(c).key === q.get("status")));
      const key = (c: Co) => (sort === "name" ? c.name : sort === "updated" ? c.updated_at : c.score);
      items = [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.id < b.id ? -1 : 1) * (dir === "asc" ? 1 : -1));
      const limit = Math.min(200, Math.max(1, Number(q.get("limit") ?? 50)));
      const cur = q.get("cursor");
      let offset = 0;
      if (cur) {
        try { offset = (JSON.parse(Buffer.from(cur, "base64url").toString()) as { o: number }).o; }
        catch { return err(422, "INVALID_CURSOR", "Некорректный курсор. Обновите список."); }
      }
      const page = items.slice(offset, offset + limit);
      const hasMore = offset + limit < items.length;
      return json(200, {
        items: page.map(out), total: items.length, cities: [...new Set(this.companies.map((c) => c.city))].sort(),
        has_more: hasMore, next_cursor: hasMore ? Buffer.from(JSON.stringify({ o: offset + limit })).toString("base64url") : null,
      });
    }
    const m = path.match(/^\/companies\/([^/]+)(\/reject)?$/);
    if (m) {
      const c = this.companies.find((x) => x.id === m[1]);
      if (!c) return err(404, "NOT_FOUND", "Компания не найдена.");
      if (m[2] && method === "POST") { c.state = "rejected"; return json(200, detail(c)); }
      if (method === "GET") return json(200, detail(c));
      if (method === "PATCH") {
        const b = JSON.parse(req.postData() ?? "{}") as { stage?: Stage; note?: string; expected_stage?: Stage };
        if (b.stage) {
          if (b.expected_stage && b.expected_stage !== c.stage) return err(409, "STAGE_CONFLICT", "Стадия уже изменена другим пользователем. Обновите карточку.", { current_stage: c.stage });
          if (c.stage === "lost" && b.stage !== "lost") return err(409, "SUPPRESSION_PERMANENT", "У компании есть отказ — стадию нельзя вернуть без нового законного основания.");
          c.stage = b.stage;
        }
        if (typeof b.note === "string") c.note = b.note;
        return json(200, detail(c));
      }
    }

    // ---- импорт ----
    if (path === "/imports/companies" && method === "POST") {
      const raw = req.postData() ?? "";
      const ctype = (headers["content-type"] ?? "").split(";")[0];
      if (ctype !== "text/csv" && ctype !== "application/json") return err(415, "UNSUPPORTED_MEDIA_TYPE", "Передайте CSV (text/csv) или JSON {text}.");
      const text = ctype === "application/json" ? (JSON.parse(raw) as { text: string }).text : raw;
      const table = parseCsv(text);
      if (table.length < 2) return err(422, "EMPTY_FILE", "В файле нет строк с данными.");
      if (table.length - 1 > 5000) return err(422, "TOO_MANY_ROWS", "Максимум 5000 строк за один импорт.");
      const dry = url.searchParams.get("dry_run") !== "false";
      const { rows, missing } = this.plan(table);
      if (dry) return json(200, { dry_run: true, rows, missing_columns: missing, summary: this.summary(rows) });
      if (missing.length) return err(422, "MISSING_COLUMNS", `В файле нет обязательных колонок: ${missing.join(", ")}.`, { missing_columns: missing });
      const summary = this.summary(rows);
      let added = 0;
      for (const r of rows) {
        if (r.issues.length || r.duplicate) continue;
        this.add({ name: r.name, city: r.city, category: r.category, score: /авто|сто/i.test(r.category) ? 35 : 10, website: r.website ? `https://${r.website}` : null, domain: r.website });
        added++;
      }
      return json(200, { dry_run: false, job_id: uuid(), rows_total: rows.length, added, skipped: rows.length - added, candidates: 0, summary });
    }
    return err(404, "NOT_FOUND", "Не найдено.");
  }
}

/** Подключает подставной сервер: cookie lh_csrf (читается клиентом) и перехват /api/v1/* в контексте страницы. */
export async function installFakeServer(page: Page, baseURL: string, opts: FakeOptions = {}): Promise<FakeServer> {
  const server = new FakeServer(opts);
  await page.context().addCookies([{ name: "lh_csrf", value: CSRF, url: baseURL }]);
  await page.context().route("**/api/v1/**", (route) => server.handle(route));
  return server;
}

/** Текст в Windows-1251 (для проверки импорта файла в кодировке Excel). */
export function toCp1251(s: string): Buffer {
  const bytes = [...s].map((ch) => {
    const c = ch.charCodeAt(0);
    if (c < 0x80) return c;
    if (c >= 0x410 && c <= 0x44f) return c - 0x350;
    if (ch === "Ё") return 0xa8;
    if (ch === "ё") return 0xb8;
    if (ch === "«") return 0xab;
    if (ch === "»") return 0xbb;
    return 0x3f;
  });
  return Buffer.from(bytes);
}
