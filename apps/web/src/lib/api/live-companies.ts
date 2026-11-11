/**
 * Реальный клиент базы компаний: /api/v1/companies*, /api/v1/imports/companies, /api/v1/dashboard.
 * Cookie-сессия, CSRF (X-CSRF-Token из cookie lh_csrf) для мутаций. Ответы сервера в snake_case переводятся в типы UI.
 */
import {
  ApiError, type ActivityEvent, type Api, type Company, type CompanyDetail, type CompanyFilter, type CompanyPage, type CompanyState,
  type CrmStage, type Fact, type ImportPreview, type ImportResult, type ImportRow, type ImportSummary, type Summary, type Tone,
} from "./types";

const BASE = "/api/v1";
const CSRF_COOKIE = "lh_csrf";
export const MAX_PAGE = 200;

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  for (const part of document.cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

type Json = Record<string, unknown>;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const STAGES: CrmStage[] = ["new", "contacted", "replied", "interested", "pilot", "lost"];
const STATES: CompanyState[] = ["discovered", "verified", "scored", "shortlisted", "rejected", "archived"];
const TONES: Tone[] = ["neutral", "green", "amber", "red"];

/** Русские тексты по кодам ошибок сервера (docs/API.md). Серверное message используется только для неизвестных кодов. */
const ERROR_TEXT: Record<string, string> = {
  STAGE_CONFLICT: "Стадию уже изменили в другом месте. Данные обновлены — повторите действие.",
  SUPPRESSION_PERMANENT: "У компании есть отказ — стадию нельзя вернуть без нового законного основания.",
  INVALID_STATE: "Это действие недоступно для компании в текущем состоянии.",
  IMPORT_CONFLICT: "Данные изменились во время импорта. Повторите попытку.",
  PAYLOAD_TOO_LARGE: "Файл слишком большой: максимум 2 МБ. Разделите его на части.",
  UNSUPPORTED_MEDIA_TYPE: "Неподдерживаемый формат файла: нужен CSV.",
  INVALID_CURSOR: "Список устарел. Обновите страницу списка.",
  EMPTY_FILE: "В файле нет строк с данными.",
  TOO_MANY_ROWS: "Максимум 5000 строк за один импорт. Разделите файл на части.",
  MISSING_COLUMNS: "В файле нет обязательных колонок.",
  INVALID_ENCODING: "Не удалось прочитать файл: нужна кодировка UTF-8 или Windows-1251.",
  VALIDATION_ERROR: "Проверьте введённые данные.",
  NOT_FOUND: "Компания не найдена.",
  UNAUTHENTICATED: "Сессия истекла. Войдите снова.",
  ACCOUNT_PENDING: "Ваш аккаунт ожидает одобрения владельцем.",
  ACCOUNT_BLOCKED: "Аккаунт заблокирован.",
  FORBIDDEN: "Недостаточно прав для этого действия.",
  CSRF_FAILED: "Сессия устарела. Обновите страницу и повторите действие.",
  ORIGIN_FORBIDDEN: "Запрос отклонён. Обновите страницу и повторите действие.",
  RATE_LIMITED: "Слишком много запросов. Подождите немного и повторите.",
  INTERNAL_ERROR: "Внутренняя ошибка сервера. Попробуйте позже.",
  NETWORK: "Нет соединения с сервером.",
};

export function errorText(code: string, status: number, serverMessage?: string, missing?: string[]): string {
  if (code === "MISSING_COLUMNS" && missing?.length) return `В файле нет обязательных колонок: ${missing.join(", ")}.`;
  const known = ERROR_TEXT[code];
  if (known) return known;
  if (status >= 500) return "Сервер временно недоступен. Попробуйте позже.";
  return serverMessage && /[а-яё]/i.test(serverMessage) ? serverMessage : `Ошибка запроса (код ${status}).`;
}

const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});

export function toCompany(raw: unknown): Company {
  const r = obj(raw), d = obj(r.display);
  const stage = STAGES.includes(r.stage as CrmStage) ? (r.stage as CrmStage) : "new";
  const state = STATES.includes(r.state as CompanyState) ? (r.state as CompanyState) : "discovered";
  return {
    id: str(r.id), name: str(r.name), city: str(r.city), category: str(r.category),
    website: typeof r.website === "string" ? r.website : null,
    domain: typeof r.domain === "string" ? r.domain : null,
    state, stage, score: num(r.score),
    display: { key: str(d.key, stage), label: str(d.label, "—"), tone: TONES.includes(d.tone as Tone) ? (d.tone as Tone) : "neutral" },
    sourceLabel: str(r.source_label), updatedAt: str(r.updated_at), demo: r.demo === true,
    duplicateCandidate: r.duplicate_candidate === true,
  };
}

export function toActivity(raw: unknown): ActivityEvent {
  const r = obj(raw);
  return {
    id: str(r.id), icon: str(r.icon, "info"), title: str(r.title), text: str(r.text), at: str(r.at),
    companyId: typeof r.company_id === "string" ? r.company_id : undefined,
    companyName: typeof r.company_name === "string" ? r.company_name : null,
  };
}

function toFact(raw: unknown): Fact {
  const r = obj(raw);
  return {
    id: str(r.id), text: str(r.text), kind: r.kind === "confirmed" ? "confirmed" : "hypothesis",
    evidenceUrl: typeof r.evidence_url === "string" ? r.evidence_url : null,
    evidenceExcerpt: typeof r.evidence_excerpt === "string" ? r.evidence_excerpt : null,
    observedAt: str(r.observed_at), confidence: num(r.confidence),
  };
}

export function toCompanyDetail(raw: unknown): CompanyDetail {
  const r = obj(raw);
  return {
    ...toCompany(raw),
    note: str(r.note),
    facts: arr(r.facts).map(toFact),
    scoreReasons: arr(r.score_reasons).map((x) => {
      const o = obj(x);
      return { rule: str(o.rule), label: str(o.label), points: num(o.points), max: num(o.max), note: str(o.note) } as CompanyDetail["scoreReasons"][number];
    }),
    scoreVersion: str(r.score_version),
    // Контакты, согласия и черновики на сервере появятся позже: сервер отдаёт заглушки.
    contacts: [],
    draftId: null,
    history: arr(r.history).map(toActivity),
  };
}

export function toPage(raw: unknown): CompanyPage {
  const r = obj(raw);
  return {
    items: arr(r.items).map(toCompany), total: num(r.total), cities: arr(r.cities).filter((x): x is string => typeof x === "string"),
    hasMore: r.has_more === true, nextCursor: typeof r.next_cursor === "string" ? r.next_cursor : null,
  };
}

const toRow = (raw: unknown): ImportRow => {
  const r = obj(raw), d = r.duplicate ? obj(r.duplicate) : null;
  const kind = d && (d.kind === "exact" || d.kind === "candidate" || d.kind === "in_file") ? d.kind : null;
  return {
    line: num(r.line), name: str(r.name), city: str(r.city), category: str(r.category),
    website: typeof r.website === "string" ? r.website : null, inn: typeof r.inn === "string" ? r.inn : null,
    issues: arr(r.issues).filter((x): x is string => typeof x === "string"),
    duplicate: d && kind ? { kind, of: str(d.of) } : null,
  };
};

const toImportSummary = (raw: unknown): ImportSummary => {
  const r = obj(raw);
  return { total: num(r.total), importable: num(r.importable), withIssues: num(r.with_issues), exact: num(r.exact), inFile: num(r.in_file), candidates: num(r.candidates) };
};

export function toImportPreview(raw: unknown): ImportPreview {
  const r = obj(raw);
  return { rows: arr(r.rows).map(toRow), missingColumns: arr(r.missing_columns).filter((x): x is string => typeof x === "string"), summary: toImportSummary(r.summary) };
}

export function toImportResult(raw: unknown): ImportResult {
  const r = obj(raw);
  return { jobId: typeof r.job_id === "string" ? r.job_id : null, rowsTotal: num(r.rows_total), added: num(r.added), skipped: num(r.skipped), candidates: num(r.candidates), summary: toImportSummary(r.summary) };
}

export function toSummary(raw: unknown): Summary {
  const r = obj(raw), st = obj(r.by_stage);
  const byStage: Partial<Record<CrmStage, number>> = {};
  for (const s of STAGES) if (typeof st[s] === "number") byStage[s] = st[s] as number;
  return {
    companiesTotal: num(r.companies_total), companiesWeek: num(r.companies_week), suitable: num(r.suitable),
    scoreThreshold: typeof r.score_threshold === "number" ? r.score_threshold : undefined,
    byStage, attention: [], recent: arr(r.recent).map(toActivity), topCompanies: arr(r.top_companies).map(toCompany),
  };
}

/** Параметры списка/экспорта. Пустые значения не отправляются. */
export function filterParams(f: CompanyFilter, withPaging: boolean): URLSearchParams {
  const p = new URLSearchParams();
  if (f.query?.trim()) p.set("query", f.query.trim());
  if (f.city) p.set("city", f.city);
  if (f.scoreMin) p.set("score_min", String(f.scoreMin));
  if (f.status) p.set("status", f.status);
  if (f.sort) p.set("sort", f.sort);
  if (f.dir) p.set("dir", f.dir);
  if (withPaging) {
    p.set("limit", String(Math.min(MAX_PAGE, Math.max(1, f.limit ?? 50))));
    if (f.cursor) p.set("cursor", f.cursor);
  }
  return p;
}

export interface LiveCompaniesApi { companies: Api["companies"]; imports: Api["imports"]; summary: Api["summary"] }

export function createLiveCompanies(fetchImpl?: FetchLike, csrf: () => string | null = () => readCookie(CSRF_COOKIE), notify: () => void = () => undefined): LiveCompaniesApi {
  const doFetch: FetchLike = fetchImpl ?? ((i, init) => fetch(i, init));

  async function call(path: string, method: "GET" | "POST" | "PATCH", opts: { json?: Json; text?: string; accept?: string } = {}): Promise<Response> {
    const headers: Record<string, string> = { Accept: opts.accept ?? "application/json" };
    if (opts.json) headers["Content-Type"] = "application/json";
    if (opts.text !== undefined) headers["Content-Type"] = "text/csv; charset=utf-8";
    if (method !== "GET") {
      const t = csrf();
      if (t) headers["X-CSRF-Token"] = t;
    }
    let res: Response;
    try {
      res = await doFetch(BASE + path, { method, headers, credentials: "same-origin", body: opts.json ? JSON.stringify(opts.json) : opts.text });
    } catch {
      throw new ApiError(0, "NETWORK", ERROR_TEXT.NETWORK!);
    }
    if (res.ok) return res;
    let data: Json | null = null;
    try { data = (await res.json()) as Json; } catch { data = null; }
    const code = typeof data?.code === "string" ? data.code : res.status === 413 ? "PAYLOAD_TOO_LARGE" : "UNKNOWN";
    const missing = arr(data?.missing_columns).filter((x): x is string => typeof x === "string");
    const cur = data?.current_stage;
    throw new ApiError(res.status, code, errorText(code, res.status, typeof data?.message === "string" ? data.message : undefined, missing), {
      requestId: typeof data?.request_id === "string" ? data.request_id : undefined,
      currentStage: STAGES.includes(cur as CrmStage) ? (cur as CrmStage) : undefined,
      missingColumns: missing.length ? missing : undefined,
    });
  }
  const json = async (res: Response): Promise<unknown> => {
    try { return await res.json(); } catch { throw new ApiError(res.status, "BAD_RESPONSE", "Сервер вернул непонятный ответ. Попробуйте позже."); }
  };
  const enc = encodeURIComponent;

  const companies: Api["companies"] = {
    async list(f) { return toPage(await json(await call(`/companies?${filterParams(f, true)}`, "GET"))); },
    async get(id) { return toCompanyDetail(await json(await call(`/companies/${enc(id)}`, "GET"))); },
    async setStage(id, stage, expected) {
      try {
        await call(`/companies/${enc(id)}`, "PATCH", { json: expected ? { stage, expected_stage: expected } : { stage } });
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) notify(); // данные устарели — списки перечитают актуальное
        throw e;
      }
      notify();
    },
    async setNote(id, note) { await call(`/companies/${enc(id)}`, "PATCH", { json: { note } }); notify(); },
    async reject(id) { await call(`/companies/${enc(id)}/reject`, "POST"); notify(); },
    async exportCsv(f) {
      const text = await (await call(`/companies/export?${filterParams(f, false)}`, "GET", { accept: "text/csv" })).text();
      return text.startsWith("﻿") ? text : "﻿" + text; // BOM, чтобы Excel открыл UTF-8 правильно
    },
  };

  const imports: Api["imports"] = {
    async preview(text) { return toImportPreview(await json(await call("/imports/companies?dry_run=true", "POST", { text }))); },
    async commit(text) {
      const r = toImportResult(await json(await call("/imports/companies?dry_run=false", "POST", { text })));
      notify();
      return r;
    },
  };

  return { companies, imports, async summary() { return toSummary(await json(await call("/dashboard", "GET"))); } };
}
