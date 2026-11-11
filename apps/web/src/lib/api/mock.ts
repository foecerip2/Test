/**
 * Mock-адаптер API (Фаза 1). Всё в памяти, без сети. Данные — демонстрационные, помечены в UI.
 * Серверные правила (can_send, optimistic lock, hash согласования, permanent suppression) реализованы здесь так же,
 * как их будет проверять FastAPI в Фазе 2: UI никогда не решает, можно ли отправлять.
 */
import { classifyReply } from "../classify";
import { sha256Hex } from "../hash";
import { mapImportRows, toCsv, canonicalDomain } from "../normalize";
import { SCORE_RULE_VERSION, scoreCompany } from "../scoring";
import { createMockAdmin } from "./mock-admin";
import { createMockAuth } from "./mock-auth";
import { SEED_COMPANIES, SEED_CONVERSATIONS, type SeedCompany } from "./seed";
import {
  ApiError, type ActivityEvent, type Api, type AuditEntry, type Campaign, type Channel, type Company, type CompanyDetail,
  type CompanyFilter, type Consent, type Contact, type Conversation, type ConversationStage, type CrmStage, type Draft,
  type DisplayStatus, type Fact, type ImportRow, type Job, type Message, type OutboxPreview, type ReasonCode,
  type Settings, type SourceConfig, type SuppressionEntry, type Task, type Summary,
} from "./types";

const DAY = 86_400_000;
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
let seq = 1000;
const uid = (p: string) => `${p}${++seq}`;

interface CompanyRec extends SeedCompany {
  state: Company["state"]; createdAt: string; updatedAt: string; note: string; demo: boolean; sourceLabel: string;
  contacts: Contact[]; factsRec: Fact[]; history: ActivityEvent[]; duplicate: boolean;
}
type DraftRec = Omit<Draft, "currentHash" | "approvalStale">;

export interface MockOptions {
  empty?: boolean; fail?: boolean; slow?: boolean;
  /** Опции демо-входа (см. mock-auth.ts). */
  fastResend?: boolean; fastExpire?: boolean; mailError?: boolean; now?: () => number; authLatency?: number;
  /** Админ-API: ?mock=lastowner — блокировка владельца всегда отвечает LAST_OWNER (гонка на сервере). */
  lastOwner?: boolean;
}

function buildBody(c: CompanyRec): string {
  const f = c.factsRec.find((x) => x.kind === "confirmed");
  const ref = f ? `Увидели на вашем сайте: ${f.text.charAt(0).toLowerCase()}${f.text.slice(1)}.` : "Познакомились с информацией о вашей компании.";
  return `Здравствуйте! ${ref} Мы разрабатываем AutoFlow — помощника, который принимает обращения клиентов и записывает их на обслуживание, пока администратор занят. Если вам это актуально, готовы показать короткий пример на сценарии вашего сервиса и обсудить пилот. Если тема не интересна, просто сообщите — мы больше не будем вас беспокоить.`;
}
const subjectFor = (c: CompanyRec) => `Заявки и запись клиентов — ${c.name}`;
const draftHash = (d: { channel: string; subject: string; body: string }) => sha256Hex(`${d.channel}\n${d.subject}\n${d.body}`);

export function createMockApi(opts: MockOptions = {}): Api {
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());

  const settings: Settings = {
    aiMode: "none", aiDailyBudgetRub: 50, aiMonthlyBudgetRub: 1500, aiSpentTodayRub: 0, aiSpentMonthRub: 0,
    emergencyStopSend: true, scoreThreshold: 75, retentionDays: 180,
  };
  const audit: AuditEntry[] = [];
  const log = (action: string, entity: string, entityId: string, meta = "") => {
    audit.unshift({ id: uid("a"), action, entity, entityId, actor: "admin", at: iso(), meta });
  };

  const companies: CompanyRec[] = [];
  const drafts: DraftRec[] = [];
  const conversations: (Conversation & { contactId: string | null })[] = [];
  const messages = new Map<string, Message[]>();
  const tasks: Task[] = [];
  const campaigns: Campaign[] = [];
  const jobs: Job[] = [];
  const suppression: SuppressionEntry[] = [];
  const hashes = new Map<string, string>();
  const queued = new Set<string>();

  const sources: SourceConfig[] = [
    { id: "csv", name: "Импорт CSV / XLSX", kind: "csv", enabled: true, licensePolicy: "Ваши данные: хранение по сроку из настроек", disabledReason: null },
    { id: "catalog", name: "Публичные каталоги и карты", kind: "catalog", enabled: false, licensePolicy: "Не проверена", disabledReason: "Включается только после проверки лицензии и условий источника (docs/SOURCES_AND_LICENSES.md)" },
  ];

  function mkContacts(s: SeedCompany): Contact[] {
    const out: Contact[] = [];
    if (s.email) {
      const st = s.email.consent;
      const consent: Consent = {
        id: uid("cn"), state: st === "verified" ? "verified" : st === "withdrawn" ? "withdrawn" : "unknown", purpose: "Рекламное предложение AutoFlow",
        proofType: st === "verified" ? "Письменное согласие (тестовое)" : null, proofRef: st === "verified" ? "demo-proof-001" : null,
        collectedAt: st === "verified" ? iso(-10 * DAY) : null, withdrawnAt: st === "withdrawn" ? iso(-3000 * 60_000) : null,
      };
      out.push({ id: uid("ct"), channel: "email", valueMasked: s.email.masked, role: "Общий адрес организации", legalBasis: "Публичный бизнес-контакт", lastVerifiedAt: iso(-5 * DAY), consent, suppressed: st === "withdrawn", platformAllowed: true });
    }
    if (s.phone) {
      out.push({ id: uid("ct"), channel: "phone", valueMasked: s.phone, role: "Телефон организации", legalBasis: "Публичный бизнес-контакт", lastVerifiedAt: null,
        consent: { id: uid("cn"), state: "unknown", purpose: "Ручной контакт", proofType: null, proofRef: null, collectedAt: null, withdrawnAt: null }, suppressed: false, platformAllowed: false });
    }
    return out;
  }

  function seedAll() {
    for (const s of SEED_COMPANIES) {
      const created = iso(-s.daysAgo * DAY);
      companies.push({
        ...s, state: s.stage === "lost" ? "rejected" : "shortlisted", createdAt: created, updatedAt: iso(-Math.max(1, s.daysAgo - 1) * DAY / 2), note: "", demo: true, sourceLabel: "Демо-набор",
        contacts: mkContacts(s), duplicate: false,
        factsRec: s.facts.map((f, i) => ({ id: `${s.id}-f${i}`, text: f.text, kind: f.kind, evidenceUrl: f.path && s.domain ? `https://${s.domain}${f.path}` : null, evidenceExcerpt: f.excerpt ?? null, observedAt: created, confidence: f.confidence })),
        history: [{ id: uid("h"), icon: "radar", title: "Компания добавлена", text: "Источник: демо-набор", at: created, companyId: s.id }],
      });
    }
    for (const sc of SEED_CONVERSATIONS) {
      const co = companies.find((c) => c.id === sc.companyId)!;
      const lastIn = [...sc.msgs].reverse()[0]!;
      const cls = (t: string) => classifyReply(t);
      messages.set(sc.id, sc.msgs.map((m, i) => ({ id: `${sc.id}-m${i}`, direction: m.dir, body: m.text, at: iso(-m.minsAgo * 60_000),
        classification: m.dir === "in" ? { label: cls(m.text).label, confidence: cls(m.text).confidence, by: "rules" as const } : null })));
      conversations.push({ id: sc.id, companyId: co.id, companyName: co.name, channel: sc.channel, stage: cls(lastIn.text).label, lastMessageAt: iso(-lastIn.minsAgo * 60_000), unread: sc.unread, preview: lastIn.text, contactId: co.contacts[0]?.id ?? null });
    }
    suppression.push({ id: uid("s"), channel: "email", endpointMasked: "a***@autoprofi.example", reason: "Отписка: «Просим больше не писать»", createdAt: iso(-3000 * 60_000) });
    // Черновики: на согласовании для c1, c4, c14, c13(тестовый)
    for (const id of ["c1", "c4", "c14", "c13"]) {
      const c = companies.find((x) => x.id === id)!;
      const ch: Channel = c.contacts.find((k) => k.channel === "email") ? "email" : "phone";
      drafts.push({ id: uid("d"), companyId: id, companyName: c.name, city: c.city, score: 0, channel: ch, subject: subjectFor(c), body: buildBody(c), version: 1, status: "pending_review",
        promptVersion: "template-v1", generator: "template", factIds: c.factsRec.filter((f) => f.kind === "confirmed").map((f) => f.id), approvedHash: null, updatedAt: iso(-DAY / 4) });
    }
    tasks.push(
      { id: uid("t"), companyId: "c3", companyName: "«МоторЛайн»", title: "Ответить на вопрос о пилоте и предложить демо", type: "demo", status: "open", dueAt: iso(DAY), priority: "high" },
      { id: uid("t"), companyId: "c2", companyName: "Автоцентр «Пятый бокс»", title: "Уточнить CRM клиента и ответить", type: "follow_up", status: "open", dueAt: iso(2 * DAY), priority: "normal" },
      { id: uid("t"), companyId: "c4", companyName: "«Гараж 24»", title: "Связаться по телефону (ручной контакт)", type: "manual_contact", status: "open", dueAt: iso(3 * DAY), priority: "normal" },
    );
    campaigns.push({ id: "k1", name: "Автосервисы — крупные города", regions: ["Москва", "Санкт-Петербург", "Казань", "Екатеринбург"], categories: ["Автосервисы и СТО"], sourceId: "csv", status: "running", perDayLimit: 50, createdAt: iso(-30 * DAY), progress: { done: 14, total: 40 } });
    jobs.push(
      { id: uid("j"), label: "Импорт CSV · демо-набор (14 строк)", type: "import", state: "succeeded", retries: 0, lastError: null, createdAt: iso(-3 * DAY), updatedAt: iso(-3 * DAY) },
      { id: uid("j"), label: "Проверка сайтов · Казань", type: "enrich", state: "running", retries: 0, lastError: null, createdAt: iso(-60_000 * 20), updatedAt: iso(-60_000 * 2) },
      { id: uid("j"), label: "Проверка сайта · avtodok-samara.example", type: "enrich", state: "failed", retries: 3, lastError: "Таймаут подключения (20 с) — повторы исчерпаны", createdAt: iso(-DAY), updatedAt: iso(-DAY) },
    );
    log("seed.demo_loaded", "system", "demo", "Загружен демо-набор");
  }
  if (!opts.empty) seedAll();

  // ---------- вспомогательные ----------
  const hashOf = async (d: DraftRec) => { const h = await draftHash(d); hashes.set(d.id, h); return h; };
  const toDraft = async (d: DraftRec): Promise<Draft> => {
    const currentHash = await hashOf(d);
    const co = companies.find((c) => c.id === d.companyId);
    return { ...d, score: co ? computeScore(co).score : 0, currentHash, approvalStale: d.approvedHash !== null && d.approvedHash !== currentHash };
  };
  const computeScore = (c: CompanyRec) => scoreCompany(c.input);
  const refusal = (c: CompanyRec) => conversations.some((v) => v.companyId === c.id && v.stage === "unsubscribe") || c.stage === "lost";

  function displayOf(c: CompanyRec): DisplayStatus {
    const conv = conversations.find((v) => v.companyId === c.id);
    const dr = drafts.find((d) => d.companyId === c.id);
    if (refusal(c)) return { key: "refused", label: "Отказ", tone: "red" };
    if (c.state === "rejected") return { key: "rejected", label: "Отклонена", tone: "red" };
    if (c.stage === "pilot") return { key: "pilot", label: "Пилот", tone: "green" };
    if (conv?.stage === "interested") return { key: "interested", label: "Заинтересован", tone: "green" };
    if (conv?.stage === "question") return { key: "question", label: "Вопрос", tone: "amber" };
    if (dr?.status === "pending_review") return { key: "awaiting_approval", label: "На согласовании", tone: "amber" };
    if (dr?.status === "approved") return { key: "approved", label: "Текст согласован", tone: "green" };
    if (c.stage === "contacted") return { key: "contacted", label: "Контакт установлен", tone: "neutral" };
    return { key: "new", label: "Новый", tone: "neutral" };
  }
  const toCompany = (c: CompanyRec): Company => ({
    id: c.id, name: c.name, city: c.city, category: c.category, website: c.domain ? `https://${c.domain}` : null, domain: c.domain, state: c.state, stage: c.stage,
    score: computeScore(c).score, display: displayOf(c), sourceLabel: c.sourceLabel, updatedAt: c.updatedAt, demo: c.demo,
  });
  const find = (id: string) => {
    const c = companies.find((x) => x.id === id);
    if (!c) throw new ApiError(404, "NOT_FOUND", "Компания не найдена");
    return c;
  };
  const findDraft = (id: string) => {
    const d = drafts.find((x) => x.id === id);
    if (!d) throw new ApiError(404, "NOT_FOUND", "Черновик не найден");
    return d;
  };
  const touch = (c: CompanyRec, title: string, text: string, icon = "check") => {
    c.updatedAt = iso();
    c.history.unshift({ id: uid("h"), icon, title, text, at: iso(), companyId: c.id });
  };

  async function gate<T>(fn: () => T | Promise<T>, write = false): Promise<T> {
    await new Promise((r) => setTimeout(r, opts.slow ? 2500 : 90));
    if (opts.fail && !write) throw new ApiError(503, "UNAVAILABLE", "Сервис временно недоступен (демо-режим ошибки)");
    const out = await fn();
    if (write) emit();
    return out;
  }

  const auth = createMockAuth({ fastResend: opts.fastResend, fastExpire: opts.fastExpire, mailError: opts.mailError, now: opts.now, latency: opts.authLatency });

  const api: Api = {
    mode: "mock",
    subscribe(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },

    authMode: "mock",
    auth,
    admin: createMockAdmin({ auth, latency: opts.authLatency, lastOwner: opts.lastOwner, fail: opts.fail, notify: emit }),

    async summary(): Promise<Summary> {
      return gate(async () => {
        const list = companies.map(toCompany);
        const weekAgo = Date.now() - 7 * DAY;
        const pending = drafts.filter((d) => d.status === "pending_review").length;
        const interestedN = conversations.filter((v) => v.stage === "interested").length;
        const unread = conversations.filter((v) => v.unread).length;
        const th = settings.scoreThreshold;
        const weekly = Array.from({ length: 8 }, (_, i) => {
          const from = Date.now() - (8 - i) * 7 * DAY, to = from + 7 * DAY;
          const inWeek = companies.filter((c) => { const t = Date.parse(c.createdAt); return t >= from && t < to; });
          return { label: `${i + 1} нед`, found: inWeek.length, passed: inWeek.filter((c) => computeScore(c).score >= th).length };
        });
        const blocked = (await Promise.all(drafts.filter((d) => d.status === "approved").map((d) => api.outbox.preview(d.id)))).filter((p) => !p.canSend).length;
        const attention: Summary["attention"] = [];
        if (pending) attention.push({ id: "n1", title: `${pending} черновиков ждут согласования`, text: "Проверьте текст и статус согласия", href: "/approvals", tone: "amber" });
        if (unread) attention.push({ id: "n2", title: `${unread} непрочитанных ответа`, text: "Новые сообщения в диалогах", href: "/inbox", tone: "amber" });
        const failed = jobs.filter((j) => j.state === "failed").length;
        if (failed) attention.push({ id: "n3", title: `${failed} задач завершились ошибкой`, text: "Проверьте очередь и причину сбоя", href: "/discovery", tone: "red" });
        if (settings.emergencyStopSend) attention.push({ id: "n4", title: "Отправка выключена", text: "Аварийный стоп включён по умолчанию", href: "/settings", tone: "neutral" });
        const events = companies.flatMap((c) => c.history).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 5);
        const withEvidence = companies.filter((c) => c.factsRec.some((f) => f.kind === "confirmed" && f.evidenceUrl)).length;
        const funnelDefs: [string, (c: CompanyRec) => boolean][] = [
          ["Найдено", () => true], ["Оценка ≥ порога", (c) => computeScore(c).score >= th], ["Черновик", (c) => drafts.some((d) => d.companyId === c.id)],
          ["Согласовано", (c) => drafts.some((d) => d.companyId === c.id && d.status === "approved")], ["Ответили", (c) => conversations.some((v) => v.companyId === c.id)],
          ["Пилот", (c) => c.stage === "pilot"],
        ];
        return {
          companiesTotal: companies.length,
          companiesWeek: companies.filter((c) => Date.parse(c.createdAt) >= weekAgo).length,
          suitable: list.filter((c) => c.score >= th).length,
          awaitingApproval: pending, interested: interestedN, unread, blockedSends: blocked,
          openTasks: tasks.filter((t) => t.status === "open").length,
          jobsActive: jobs.filter((j) => j.state === "running" || j.state === "queued").length,
          funnel: funnelDefs.map(([label, f]) => ({ label, count: companies.filter(f).length })),
          weekly,
          quality: { duplicatesMarked: companies.filter((c) => c.duplicate).length, refusals: conversations.filter((v) => v.stage === "unsubscribe" || v.stage === "not_interested").length,
            withEvidencePct: companies.length ? Math.round((withEvidence / companies.length) * 100) : 0, suppressed: suppression.length },
          attention, recent: events,
          topCompanies: [...list].filter((c) => c.display.key !== "refused" && c.display.key !== "rejected").sort((a, b) => b.score - a.score).slice(0, 4),
        };
      });
    },

    companies: {
      async list(f: CompanyFilter) {
        return gate(() => {
          const q = f.query?.trim().toLowerCase();
          let items = companies.map(toCompany).filter((c) =>
            (!q || `${c.name} ${c.city} ${c.category} ${c.domain ?? ""}`.toLowerCase().includes(q)) &&
            (!f.city || c.city === f.city) && (!f.scoreMin || c.score >= f.scoreMin) && (!f.status || c.display.key === f.status));
          const sort = f.sort ?? "score", dir = f.dir === "asc" ? 1 : -1;
          items.sort((a, b) => dir * (sort === "name" ? a.name.localeCompare(b.name, "ru") : sort === "updated" ? Date.parse(a.updatedAt) - Date.parse(b.updatedAt) : a.score - b.score));
          const total = items.length;
          const limit = f.limit ?? 50;
          items = items.slice(0, limit);
          return { items, total, cities: [...new Set(companies.map((c) => c.city))].sort((a, b) => a.localeCompare(b, "ru")), hasMore: total > limit };
        });
      },
      async get(id): Promise<CompanyDetail> {
        return gate(() => {
          const c = find(id);
          const sc = computeScore(c);
          const dr = drafts.find((d) => d.companyId === id && d.status !== "rejected");
          return { ...toCompany(c), facts: c.factsRec, scoreReasons: sc.reasons, scoreVersion: SCORE_RULE_VERSION, contacts: c.contacts, history: c.history, draftId: dr?.id ?? null, note: c.note };
        });
      },
      async setStage(id, stage: CrmStage) { return gate(() => { const c = find(id); if (refusal(c) && stage !== "lost") throw new ApiError(409, "SUPPRESSION_PERMANENT", "У компании есть отказ или отписка — стадию нельзя вернуть без нового законного основания"); c.stage = stage; touch(c, "Стадия изменена", `Новая стадия: ${stage}`, "columns"); log("company.stage", "company", id, stage); }, true); },
      async setNote(id, note) { return gate(() => { const c = find(id); c.note = note.slice(0, 2000); touch(c, "Заметка обновлена", "", "file"); log("company.note", "company", id); }, true); },
      async reject(id) { return gate(() => { const c = find(id); c.state = "rejected"; touch(c, "Компания отклонена", "Исключена из работы", "shield"); log("company.reject", "company", id); }, true); },
      async exportCsv(f) {
        const page = await api.companies.list({ ...f, limit: 10_000 });
        return toCsv([["Компания", "Город", "Категория", "Сайт", "Оценка", "Статус"], ...page.items.map((c) => [c.name, c.city, c.category, c.domain ?? "", c.score, c.display.label])]);
      },
    },

    imports: {
      async preview(text) {
        return gate(async () => {
          const { parseCsv } = await import("../normalize");
          const table = parseCsv(text);
          if (table.length < 2) throw new ApiError(422, "EMPTY_FILE", "В файле нет строк с данными");
          if (table.length > 5001) throw new ApiError(422, "TOO_MANY_ROWS", "Максимум 5000 строк за один импорт");
          return mapImportRows(table, companies.map((c) => ({ name: c.name, city: c.city, domain: c.domain, inn: c.inn ?? null })));
        });
      },
      async commit(rowsIn: ImportRow[]) {
        return gate(() => {
          let rows = rowsIn;
          if (rows.length > 5000) throw new ApiError(422, "TOO_MANY_ROWS", "Максимум 5000 строк за один импорт");
          // Не доверяем клиенту: проверка и дедупликация выполняются заново.
          const table = [["название", "город", "категория", "сайт", "инн"], ...rows.map((r) => [r.name, r.city, r.category, r.website ?? "", r.inn ?? ""])];
          rows = mapImportRows(table, companies.map((c) => ({ name: c.name, city: c.city, domain: c.domain, inn: c.inn ?? null }))).rows;
          let added = 0, skipped = 0;
          for (const r of rows) {
            if (r.issues.length || (r.duplicate && r.duplicate.kind !== "candidate")) { skipped++; continue; }
            const domain = canonicalDomain(r.website);
            const id = uid("c");
            const isAuto = /(автосервис|сто\b|ремонт|шиномонтаж|кузов|детейлинг|автомойк)/i.test(r.category);
            // Ничего не проверялось: сайт и онлайн-запись не считаются подтверждёнными, баллы не начисляются.
            const input = { businessType: isAuto ? ("autoservice" as const) : ("other" as const), demandSignals: 0, siteWorks: false, onlineBookingDetected: null, hasBusinessContact: false, isDuplicate: false, hasRefusal: false };
            const rec: CompanyRec = {
              id, name: r.name, city: r.city, category: r.category, domain, inn: r.inn ?? undefined, input, stage: "new", daysAgo: 0, facts: [], state: "discovered",
              createdAt: iso(), updatedAt: iso(), note: "", demo: false, sourceLabel: "Импорт CSV", contacts: [], factsRec: [], duplicate: false,
              history: [{ id: uid("h"), icon: "download", title: "Импортирована из CSV", text: `Строка ${r.line}`, at: iso(), companyId: id }],
            };
            if (r.duplicate?.kind === "candidate") { rec.duplicate = true; rec.history.unshift({ id: uid("h"), icon: "info", title: "Возможный дубликат", text: `Похожа на «${r.duplicate.of}» — проверьте вручную`, at: iso(), companyId: id }); }
            companies.push(rec); added++;
          }
          jobs.unshift({ id: uid("j"), label: `Импорт CSV (${rows.length} строк)`, type: "import", state: "succeeded", retries: 0, lastError: null, createdAt: iso(), updatedAt: iso() });
          log("import.commit", "import", "csv", `добавлено ${added}, пропущено ${skipped}`);
          return { added, skipped };
        }, true);
      },
    },

    campaigns: {
      async list() { return gate(() => [...campaigns]); },
      async create(input) {
        return gate(() => {
          if (!input.name.trim()) throw new ApiError(422, "VALIDATION", "Укажите название кампании");
          if (!input.regions.length) throw new ApiError(422, "VALIDATION", "Выберите хотя бы один регион");
          const src = sources.find((s) => s.id === input.sourceId);
          if (!src?.enabled) throw new ApiError(409, "SOURCE_DISABLED", src?.disabledReason ?? "Источник недоступен");
          const k: Campaign = { id: uid("k"), ...input, status: "running", createdAt: iso(), progress: { done: 0, total: 0 } };
          campaigns.unshift(k);
          jobs.unshift({ id: uid("j"), label: `Кампания «${k.name}» — ожидает импорт данных`, type: "discover", state: "queued", retries: 0, lastError: null, createdAt: iso(), updatedAt: iso() });
          log("campaign.create", "campaign", k.id, k.name);
          return k;
        }, true);
      },
      async setStatus(id, status) { return gate(() => { const k = campaigns.find((x) => x.id === id); if (!k) throw new ApiError(404, "NOT_FOUND", "Кампания не найдена"); k.status = status; log(`campaign.${status}`, "campaign", id); }, true); },
    },
    jobs: {
      async list() { return gate(() => [...jobs]); },
      async cancel(id) { return gate(() => { const j = jobs.find((x) => x.id === id); if (!j) throw new ApiError(404, "NOT_FOUND", "Задача не найдена"); if (j.state !== "running" && j.state !== "queued") throw new ApiError(409, "NOT_CANCELLABLE", "Задачу уже нельзя отменить"); j.state = "cancelled"; j.updatedAt = iso(); log("job.cancel", "job", id); }, true); },
    },
    async sources() { return gate(() => [...sources]); },

    drafts: {
      async list() { return gate(async () => Promise.all(drafts.filter((d) => d.status !== "rejected").map(toDraft))); },
      async get(id) { return gate(() => toDraft(findDraft(id))); },
      async generate(companyId, channel) {
        return gate(async () => {
          const c = find(companyId);
          const existing = drafts.find((d) => d.companyId === companyId && d.status !== "rejected");
          if (existing) return toDraft(existing);
          const d: DraftRec = { id: uid("d"), companyId, companyName: c.name, city: c.city, score: 0, channel, subject: subjectFor(c), body: buildBody(c), version: 1, status: "pending_review",
            promptVersion: "template-v1", generator: "template", factIds: c.factsRec.filter((f) => f.kind === "confirmed").map((f) => f.id), approvedHash: null, updatedAt: iso() };
          drafts.unshift(d); touch(c, "Создан черновик", "Шаблон без AI, версия template-v1", "file"); log("draft.generate", "draft", d.id);
          return toDraft(d);
        }, true);
      },
      async update(id, patch, expectedVersion) {
        return gate(async () => {
          const d = findDraft(id);
          if (d.status === "rejected") throw new ApiError(409, "INVALID_STATE", "Черновик отклонён и недоступен для правок");
          if (d.version !== expectedVersion) throw new ApiError(409, "VERSION_CONFLICT", "Черновик изменён в другом месте. Обновите страницу.");
          if (patch.body !== undefined) {
            if (!patch.body.trim()) throw new ApiError(422, "VALIDATION", "Текст не может быть пустым");
            if (patch.body.length > 4000) throw new ApiError(422, "VALIDATION", "Слишком длинный текст (максимум 4000 символов)");
            d.body = patch.body;
          }
          if (patch.channel) d.channel = patch.channel;
          if (patch.subject !== undefined) d.subject = patch.subject;
          d.version++; d.updatedAt = iso();
          if (d.status === "approved") d.status = "pending_review"; // изменённый текст требует нового согласования
          log("draft.edit", "draft", id, `v${d.version}`);
          return toDraft(d);
        }, true);
      },
      async approve(id, expectedVersion) {
        return gate(async () => {
          const d = findDraft(id);
          if (d.status === "rejected") throw new ApiError(409, "INVALID_STATE", "Отклонённый черновик нельзя согласовать");
          if (d.version !== expectedVersion) throw new ApiError(409, "VERSION_CONFLICT", "Черновик изменён. Проверьте актуальный текст перед согласованием.");
          d.approvedHash = await hashOf(d); d.status = "approved"; d.updatedAt = iso();
          touch(find(d.companyId), "Текст согласован", "Согласие адресата проверяется отдельно", "check"); log("draft.approve", "draft", id, d.approvedHash.slice(0, 12));
          return toDraft(d);
        }, true);
      },
      async reject(id) { return gate(async () => { const d = findDraft(id); d.status = "rejected"; touch(find(d.companyId), "Черновик отклонён", "", "shield"); log("draft.reject", "draft", id); return toDraft(d); }, true); },
    },

    outbox: {
      async preview(draftId): Promise<OutboxPreview> {
        const d = findDraft(draftId);
        const draft = await toDraft(d);
        const co = find(d.companyId);
        const contact = co.contacts.find((k) => k.channel === d.channel) ?? null;
        const reasons: ReasonCode[] = [];
        if (!contact) reasons.push("NO_CONTACT");
        if (contact && !contact.platformAllowed) reasons.push("CHANNEL_NOT_SUPPORTED");
        if (contact?.suppressed) reasons.push("SUPPRESSED");
        if (contact?.consent.state === "withdrawn") reasons.push("CONSENT_WITHDRAWN");
        else if (contact && contact.consent.state !== "verified") reasons.push("CONSENT_NOT_VERIFIED");
        const approvedNow = d.status === "approved" && d.approvedHash !== null && d.approvedHash === draft.currentHash;
        if (!approvedNow) reasons.push(draft.approvalStale ? "APPROVAL_STALE" : "TEXT_NOT_APPROVED");
        if (queued.has(draftId)) reasons.push("ALREADY_QUEUED");
        if (settings.emergencyStopSend) reasons.push("EMERGENCY_STOP");
        const next: OutboxPreview["nextAction"] = reasons.includes("TEXT_NOT_APPROVED") || reasons.includes("APPROVAL_STALE") ? "approve_text"
          : reasons.includes("CONSENT_NOT_VERIFIED") && contact?.platformAllowed ? "record_consent"
          : reasons.includes("EMERGENCY_STOP") && reasons.length === 1 ? "enable_sending"
          : reasons.length ? "manual_contact" : "none";
        return {
          draftId, channel: d.channel, contactId: contact?.id ?? null, recipientVerified: !!contact?.lastVerifiedAt, ownerApproved: approvedNow,
          consentState: contact?.consent.state ?? "unknown", platformAllowed: !!contact?.platformAllowed, suppressed: !!contact?.suppressed, emergencyStop: settings.emergencyStopSend,
          canSend: reasons.length === 0, reasonCodes: reasons, nextAction: next,
        };
      },
      async send(draftId) {
        return gate(async () => {
          const p = await api.outbox.preview(draftId);
          if (!p.canSend) throw new ApiError(403, "SEND_BLOCKED", `Отправка заблокирована: ${p.reasonCodes.join(", ")}`);
          const d = findDraft(draftId);
          queued.add(draftId);
          touch(find(d.companyId), "Демо: отправка поставлена в очередь", "Реальная отправка в этом режиме не выполняется", "send"); log("outbox.send_demo", "draft", draftId);
          return { status: "queued_demo" as const };
        }, true);
      },
    },

    consents: {
      async record(contactId, input) {
        return gate(() => {
          if (!input.proofType.trim() || !input.proofRef.trim()) throw new ApiError(422, "VALIDATION", "Укажите тип и ссылку на доказательство согласия");
          for (const c of companies) { const k = c.contacts.find((x) => x.id === contactId); if (k) {
            if (k.suppressed) throw new ApiError(409, "SUPPRESSED", "Адрес в списке подавления — согласие не может снять блокировку без нового законного основания");
            k.consent = { ...k.consent, state: "verified", proofType: input.proofType, proofRef: input.proofRef, collectedAt: iso(), withdrawnAt: null };
            touch(c, "Записано согласие адресата", input.proofType, "shield"); log("consent.record", "contact", contactId, input.proofType); return; } }
          throw new ApiError(404, "NOT_FOUND", "Контакт не найден");
        }, true);
      },
      async withdraw(contactId) {
        return gate(() => {
          for (const c of companies) { const k = c.contacts.find((x) => x.id === contactId); if (k) {
            k.consent = { ...k.consent, state: "withdrawn", withdrawnAt: iso() }; k.suppressed = true;
            suppression.unshift({ id: uid("s"), channel: k.channel, endpointMasked: k.valueMasked, reason: "Согласие отозвано", createdAt: iso() });
            touch(c, "Согласие отозвано", "Адрес добавлен в список подавления", "shield"); log("consent.withdraw", "contact", contactId); return; } }
          throw new ApiError(404, "NOT_FOUND", "Контакт не найден");
        }, true);
      },
    },

    conversations: {
      async list() { return gate(() => [...conversations].sort((a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt)).map((v) => ({ id: v.id, companyId: v.companyId, companyName: v.companyName, channel: v.channel, stage: v.stage, lastMessageAt: v.lastMessageAt, unread: v.unread, preview: v.preview }))); },
      async messages(id) { return gate(() => { const m = messages.get(id); if (!m) throw new ApiError(404, "NOT_FOUND", "Диалог не найден"); return m; }); },
      async classify(id, label: ConversationStage) {
        return gate(() => {
          const v = conversations.find((x) => x.id === id);
          if (!v) throw new ApiError(404, "NOT_FOUND", "Диалог не найден");
          if (v.stage === "unsubscribe" && label !== "unsubscribe") throw new ApiError(409, "SUPPRESSION_PERMANENT", "Отписка необратима: адрес остаётся в списке подавления до появления нового законного основания");
          v.stage = label;
          const m = [...(messages.get(id) ?? [])].reverse().find((x) => x.direction === "in");
          if (m) m.classification = { label, confidence: 1, by: "manual" };
          const co = find(v.companyId);
          if (label === "unsubscribe") {
            const k = co.contacts.find((x) => x.channel === v.channel);
            if (k) { k.suppressed = true; k.consent = { ...k.consent, state: "withdrawn", withdrawnAt: iso() };
              if (!suppression.some((s) => s.endpointMasked === k.valueMasked)) suppression.unshift({ id: uid("s"), channel: k.channel, endpointMasked: k.valueMasked, reason: "Отписка в диалоге", createdAt: iso() }); }
            co.stage = "lost";
          } else if (label === "interested") co.stage = "interested";
          else if (label === "replied" || label === "question") co.stage = "replied";
          touch(co, "Ответ классифицирован", label, "chat"); log("conversation.classify", "conversation", id, label);
        }, true);
      },
      async markRead(id) { return gate(() => { const v = conversations.find((x) => x.id === id); if (v) v.unread = false; }, true); },
    },

    tasks: {
      async list() { return gate(() => [...tasks].sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))); },
      async create(input) {
        return gate(() => {
          if (!input.title.trim()) throw new ApiError(422, "VALIDATION", "Укажите название задачи");
          const co = input.companyId ? find(input.companyId) : null;
          const t: Task = { id: uid("t"), ...input, companyName: co?.name ?? null, status: "open" };
          tasks.unshift(t); if (co) touch(co, "Создана задача", t.title, "clock"); log("task.create", "task", t.id); return t;
        }, true);
      },
      async setStatus(id, status) { return gate(() => { const t = tasks.find((x) => x.id === id); if (t) t.status = status; log("task.status", "task", id, status); }, true); },
    },

    async suppression() { return gate(() => [...suppression]); },
    async audit() { return gate(() => [...audit]); },
    settings: {
      async get() { return gate(() => ({ ...settings })); },
      async patch(p) {
        return gate(() => {
          const allowed = ["aiMode", "aiDailyBudgetRub", "aiMonthlyBudgetRub", "emergencyStopSend", "scoreThreshold", "retentionDays"] as const;
          const clean: Partial<Settings> = {};
          for (const k of allowed) if (p[k] !== undefined) (clean as Record<string, unknown>)[k] = p[k];
          const bad = (v: unknown, lo: number, hi: number) => typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi;
          if (clean.scoreThreshold !== undefined && bad(clean.scoreThreshold, 0, 100)) throw new ApiError(422, "VALIDATION", "Порог — число от 0 до 100");
          if (clean.aiDailyBudgetRub !== undefined && bad(clean.aiDailyBudgetRub, 0, 100_000)) throw new ApiError(422, "VALIDATION", "Дневной бюджет — число от 0 до 100000");
          if (clean.aiMonthlyBudgetRub !== undefined && bad(clean.aiMonthlyBudgetRub, 0, 1_000_000)) throw new ApiError(422, "VALIDATION", "Месячный бюджет — число от 0 до 1000000");
          if (clean.retentionDays !== undefined && bad(clean.retentionDays, 1, 3650)) throw new ApiError(422, "VALIDATION", "Срок хранения — от 1 до 3650 дней");
          if (clean.aiMode !== undefined && !["none", "api", "manual"].includes(clean.aiMode)) throw new ApiError(422, "VALIDATION", "Неизвестный режим AI");
          if ((clean.aiMonthlyBudgetRub ?? settings.aiMonthlyBudgetRub) < (clean.aiDailyBudgetRub ?? settings.aiDailyBudgetRub)) throw new ApiError(422, "VALIDATION", "Месячный бюджет не может быть меньше дневного");
          Object.assign(settings, clean); log("settings.patch", "settings", "main", Object.keys(p).join(", ")); return { ...settings };
        }, true);
      },
    },
  };
  return api;
}
