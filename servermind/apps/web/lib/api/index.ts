import type {
  ActionPlan, AiKey, AuditEvent, Balance, ChatMessage, DeployTemplate, Deployment, FeatureFlag, Invite,
  JobEvent, LedgerEntry, Me, MetricSample, Operation, PlatformModel, Provider, Result, ServerSummary, SessionInfo,
} from "@/lib/types";

/**
 * Единая точка доступа к данным.
 * - NEXT_PUBLIC_DEV_FIXTURES=1 → dev-фикстуры (fixtures/dev), всегда с ribbon «Демо-данные».
 * - иначе → реальный API /api/v1. Пока бэкенд не развёрнут (Фаза 2), каждый вызов возвращает
 *   `backend_unavailable`, и UI показывает честное состояние ошибки.
 * Значение флага подставляется на этапе сборки, поэтому в production-бандл фикстуры не попадают.
 */
// ВАЖНО: проверка process.env.NEXT_PUBLIC_DEV_FIXTURES пишется буквально на месте использования —
// только так бандлер сворачивает её на этапе сборки и вырезает фикстуры из production (проверено grep по .next).
type Fx = typeof import("@/fixtures/dev/store");
const fx = (): Promise<Fx> => {
  if (process.env.NEXT_PUBLIC_DEV_FIXTURES === "1") return import("@/fixtures/dev/store");
  return Promise.reject(new Error("dev-фикстуры отключены"));
};

const unavailable = <T,>(): Result<T> => ({
  ok: false,
  code: "backend_unavailable",
  message: "Серверная часть ServerMind недоступна: API ещё не подключён (Фаза 2) или не отвечает.",
});

// CSRF-токен сессии: только в памяти модуля (не в localStorage/sessionStorage). После перезагрузки страницы
// восстанавливается запросом GET /me перед первой мутацией.
let csrfToken: string | null = null;

async function ensureCsrf(): Promise<void> {
  if (csrfToken) return;
  try {
    const r = await fetch("/api/v1/me", { credentials: "same-origin", cache: "no-store" });
    if (r.ok && (r.headers.get("content-type") ?? "").includes("application/json")) {
      const j = (await r.json()) as { csrfToken?: unknown };
      if (typeof j.csrfToken === "string") csrfToken = j.csrfToken;
    } else await r.body?.cancel().catch(() => undefined);
  } catch { /* бэкенд недоступен — основной запрос вернёт понятную ошибку */ }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<Result<T>> {
  try {
    const mutating = method !== "GET";
    if (mutating && path !== "/auth/login") await ensureCsrf();
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (mutating && csrfToken) headers["x-csrf-token"] = csrfToken;
    const res = await fetch(`/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
    const isJson = res.headers.get("content-type")?.includes("application/json") ?? false;
    if (!isJson) {
      // 404/5xx от Next или прокси без API. Тело обязательно закрываем, иначе соединение остаётся «в полёте».
      await res.body?.cancel().catch(() => undefined);
      return unavailable<T>();
    }
    const json = (await res.json()) as { detail?: string; message?: string } & Record<string, unknown>;
    if (res.ok) {
      if (typeof json.csrfToken === "string") csrfToken = json.csrfToken;
      if (path === "/auth/logout") csrfToken = null;
      return { ok: true, data: json as T };
    }
    const message = json.message ?? json.detail ?? `Ошибка ${res.status}`;
    if (res.status === 401) { csrfToken = null; return { ok: false, code: "unauthorized", message }; }
    if (res.status === 403) return { ok: false, code: "forbidden", message };
    if (res.status === 404) return { ok: false, code: "not_found", message };
    if (res.status === 422 || res.status === 400) return { ok: false, code: "validation", message };
    return { ok: false, code: "error", message };
  } catch {
    return unavailable<T>();
  }
}

/** Выбор источника: фикстуры (только dev) или реальный API. */
async function pick<T>(f: (m: Fx) => Promise<Result<T>>, real: () => Promise<Result<T>>): Promise<Result<T>> {
  if (process.env.NEXT_PUBLIC_DEV_FIXTURES === "1") return f(await fx());
  return real();
}

export interface AddServerInput { name: string; host: string; port: number; username: string; fingerprint: string; acceptRootRisk?: boolean }
export interface PlatformModelList { models: PlatformModel[]; envFallback: boolean; note: string }
export interface AddPlatformModelInput { provider: Provider; model: string; key: string; priceIn: number; priceOut: number; priceListVersion: string; skipValidation: boolean }
const DEMO_ONLY = { ok: false as const, code: "error" as const, message: "Подключение моделей платформы доступно только с реальным API." };
export interface ProbeResult { fingerprint: string; keyType: string; source: "ssh" | "demo" }
export interface VerifyResult { os: string; server: ServerSummary }
/** Ответ реального API на подтверждение (Фаза 3): согласие записано, исполнитель появится в Фазе 4. */
export interface ApprovalRecorded { planId: string; status: "approved"; executionAvailable: false; rehearsalAvailable?: boolean; message: string }

/** Ответ исполнителя (режим «репетиция») приводится к общему типу Operation. На сервер при этом ничего не отправляется. */
interface RawJobStep { order: number; stepId: string; tool: string; status: string; checks: { name: string; ok: boolean; detail: string }[]; plannedAction: string; at: string }
interface RawJob {
  id: string; planId: string; serverId: string; serverName: string; title: string; risk: Operation["risk"]; actor: string;
  status: Operation["status"]; summary: string; createdAt: string; startedAt: string | null; finishedAt: string | null;
  stepsDone: number; stepsTotal: number; steps?: RawJobStep[];
}
const STEP_LABEL: Record<string, string> = { rehearsed: "проверки пройдены", blocked: "остановлен", failed: "ошибка", skipped: "пропущен" };
export function adaptJob(j: RawJob): Operation {
  const events: JobEvent[] = [];
  let n = 0;
  const push = (at: string, level: JobEvent["level"], message: string, step?: string) => events.push({ id: `${j.id}:${n++}`, at, level, message, step });
  push(j.createdAt, "info", "Репетиция поставлена в очередь. На сервере ничего не выполняется.");
  for (const s of j.steps ?? []) {
    const level = s.status === "rehearsed" ? "info" : s.status === "skipped" ? "warn" : "error";
    push(s.at, level, `Шаг ${s.order} · ${s.tool}: ${STEP_LABEL[s.status] ?? s.status}`, s.stepId);
    for (const c of s.checks.filter((c) => !c.ok)) push(s.at, "error", `Проверка «${c.name}» не пройдена: ${c.detail}`, s.stepId);
    if (s.plannedAction) push(s.at, "info", `Было бы выполнено (не выполнялось): ${s.plannedAction}`, s.stepId);
  }
  if (j.finishedAt) push(j.finishedAt, j.status === "succeeded" ? "info" : "warn", j.summary);
  return {
    id: j.id, planId: j.planId, title: j.title, serverId: j.serverId, serverName: j.serverName, status: j.status, risk: j.risk,
    actor: j.actor, createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt, stepsDone: j.stepsDone,
    stepsTotal: j.stepsTotal, events, source: "ssh", mode: "rehearsal",
  };
}
const mapOk = <A, B>(r: Result<A>, f: (a: A) => B): Result<B> => (r.ok ? { ok: true, data: f(r.data) } : r);
export interface PreflightCheck { id: string; label: string; status: "pass" | "warn" | "fail"; detail: string; blocking: boolean }
export interface DeployInput { serverId: string; templateId: string; domain: string; envKeys: string[] }
export interface Policy { requireApprovalR2: true; requireApprovalR3: true; planTtlMinutes: number; maxOperationsPerDay: number }

export const api = {
  /** Подписка на изменения источника данных (фикстуры). В боевом режиме — no-op. */
  subscribe(cb: () => void): () => void {
    if (process.env.NEXT_PUBLIC_DEV_FIXTURES !== "1") return () => undefined;
    let off: (() => void) | undefined;
    let cancelled = false;
    void fx().then((m) => { if (!cancelled) off = m.subscribe(cb); });
    return () => { cancelled = true; off?.(); };
  },

  auth: {
    me: () => pick<Me>((m) => m.me(), () => request("GET", "/me")),
    login: (email: string, password: string) =>
      pick<{ twoFactorRequired: boolean; twoFactorSetupRequired?: boolean }>((m) => m.login(email, password), () => request("POST", "/auth/login", { email, password })),
    verify2fa: (code: string) =>
      pick<{ ok: true }>((m) => m.verify2fa(code), () => request("POST", "/auth/2fa", { code })),
    /** Первичная настройка TOTP: секрет показывается один раз (для приложения-аутентификатора). */
    setup2fa: () => pick<{ secret: string; otpauthUri: string }>((m) => m.setup2fa(), () => request("POST", "/auth/2fa/setup")),
    enable2fa: (code: string) =>
      pick<{ ok: true }>((m) => m.enable2fa(code), () => request("POST", "/auth/2fa/enable", { code })),
    logout: () => pick<{ ok: true }>((m) => m.logout(), () => request("POST", "/auth/logout")),
  },

  servers: {
    list: () => pick<ServerSummary[]>((m) => m.servers(), () => request("GET", "/servers")),
    get: (id: string) => pick<ServerSummary>((m) => m.server(id), () => request("GET", `/servers/${encodeURIComponent(id)}`)),
    publicKey: () => pick<{ key: string; source: "ssh" | "demo" }>((m) => m.publicKey(), () => request("GET", "/servers/public-key")),
    probe: (input: { host: string; port: number }) =>
      pick<ProbeResult>((m) => m.probe(input), () => request("POST", "/servers/probe", input)),
    add: (input: AddServerInput) =>
      pick<VerifyResult>((m) => m.addServer(input), () => request("POST", "/servers", input)),
    recheck: (id: string) =>
      pick<ServerSummary>((m) => m.recheck(id), () => request("POST", `/servers/${encodeURIComponent(id)}/verify`)),
    logs: (id: string, unit: string) =>
      pick<{ lines: string[]; fetchedAt: string; source: "ssh" | "demo" }>((m) => m.logs(id, unit), () =>
        request<{ lines: string[]; fetchedAt: string; source: "ssh" | "demo" }>("GET",`/servers/${encodeURIComponent(id)}/services/${encodeURIComponent(unit)}/logs`)),
  },

  assistant: {
    history: (serverId: string) =>
      pick<ChatMessage[]>((m) => m.history(serverId), () => request("GET", `/conversations?server=${encodeURIComponent(serverId)}`)),
    send: (serverId: string, text: string) =>
      pick<ChatMessage[]>((m) => m.send(serverId, text), () =>
        request("POST", "/conversations/messages", { server_id: serverId, text })),
  },

  operations: {
    list: () => pick<Operation[]>((m) => m.operations(), async () => mapOk(await request<RawJob[]>("GET", "/jobs"), (a) => a.map(adaptJob))),
    get: (id: string) => pick<Operation>((m) => m.operation(id), async () => mapOk(await request<RawJob>("GET", `/jobs/${encodeURIComponent(id)}`), adaptJob)),
    cancel: (id: string) => pick<Operation>((m) => m.cancel(id), () => request("POST", `/jobs/${encodeURIComponent(id)}/cancel`)),
  },

  plans: {
    get: (id: string) => pick<ActionPlan>((m) => m.plan(id), () => request("GET", `/action-plans/${encodeURIComponent(id)}`)),
    setStepEnabled: (id: string, stepId: string, enabled: boolean) =>
      pick<ActionPlan>((m) => m.setStepEnabled(id, stepId, enabled), () =>
        request("POST", `/action-plans/${encodeURIComponent(id)}/steps/${encodeURIComponent(stepId)}`, { enabled })),
    approve: (id: string, sig: { hash: string; revision: number }) =>
      pick<Operation | ApprovalRecorded>((m) => m.approve(id, sig), () => request("POST", `/action-plans/${encodeURIComponent(id)}/approve`, sig)),
    reject: (id: string) =>
      pick<ActionPlan>((m) => m.reject(id), () => request("POST", `/action-plans/${encodeURIComponent(id)}/reject`)),
    /** Репетиция подтверждённого плана: все проверки исполнителя, без изменений на сервере. Только реальный API. */
    rehearse: async (id: string): Promise<Result<Operation>> => {
      if (process.env.NEXT_PUBLIC_DEV_FIXTURES === "1") return { ok: false, code: "error", message: "Репетиция доступна только с реальным API." };
      return mapOk(await request<RawJob>("POST", `/action-plans/${encodeURIComponent(id)}/rehearse`), adaptJob);
    },
  },

  deploy: {
    templates: () => pick<DeployTemplate[]>((m) => m.templates(), () => request("GET", "/deployments/templates")),
    list: () => pick<Deployment[]>((m) => m.deployments(), () => request("GET", "/deployments")),
    preflight: (input: DeployInput) =>
      pick<PreflightCheck[]>((m) => m.preflight(input), () => request("POST", "/deployments/preflight", input)),
    createPlan: (input: DeployInput) =>
      pick<ActionPlan>((m) => m.createDeployPlan(input), () => request("POST", "/deployments", input)),
  },

  monitoring: {
    history: (serverId: string, hours: number) =>
      pick<{ samples: MetricSample[]; intervalSec: number; source: "ssh" | "demo" }>((m) => m.history_(serverId, hours), () =>
        request("GET", `/servers/${encodeURIComponent(serverId)}/metrics?hours=${hours}`)),
  },

  billing: {
    balance: () => pick<Balance>((m) => m.balance(), () => request("GET", "/billing/balance")),
    ledger: () => pick<LedgerEntry[]>((m) => m.ledger(), () => request("GET", "/billing/usage")),
    getMode: () => pick<{ mode: "byok" | "credits" }>((m) => m.getMode(), () => request("GET", "/billing/mode")),
    setMode: (mode: "byok" | "credits") =>
      pick<{ mode: "byok" | "credits" }>((m) => m.setMode(mode), () => request("PUT", "/billing/mode", { mode })),
  },

  settings: {
    sessions: () => pick<SessionInfo[]>((m) => m.sessions(), () => request("GET", "/me/sessions")),
    revokeSession: (id: string) =>
      pick<{ ok: true }>((m) => m.revokeSession(id), () => request("DELETE", `/me/sessions/${encodeURIComponent(id)}`)),
    policy: () => pick<Policy>((m) => m.policy(), () => request("GET", "/me/policy")),
    setPolicy: (p: Partial<Policy>) => pick<Policy>((m) => m.setPolicy(p), () => request("PUT", "/me/policy", p)),
    deleteServerSecrets: (serverId: string) =>
      pick<{ ok: true }>((m) => m.deleteSecrets(serverId), () =>
        request("DELETE", `/servers/${encodeURIComponent(serverId)}/credentials`)),
  },

  admin: {
    aiKeys: () => pick<AiKey[]>((m) => m.keys(), () => request("GET", "/admin/ai-keys")),
    addAiKey: (input: { provider: Provider; key: string; model: string; skipValidation: boolean }) =>
      pick<AiKey>((m) => m.addKey(input), () => request("POST", "/admin/ai-keys", input)),
    deleteAiKey: (id: string) =>
      pick<{ ok: true; revoked?: boolean }>((m) => m.deleteKey(id), () => request("DELETE", `/admin/ai-keys/${encodeURIComponent(id)}`)),
    invites: () => pick<Invite[]>((m) => m.invites(), () => request("GET", "/admin/invites")),
    createInvite: () => pick<Invite>((m) => m.createInvite(), () => request("POST", "/admin/invites")),
    audit: () => pick<AuditEvent[]>((m) => m.audit(), () => request("GET", "/admin/audit")),
    /** Модели платформы (режим Credits): только администратор платформы, только реальный API. Ключ никогда не возвращается. */
    models: async (): Promise<Result<PlatformModelList>> =>
      process.env.NEXT_PUBLIC_DEV_FIXTURES === "1"
        ? { ok: true, data: { models: [], envFallback: false, note: "Демо-режим: модели платформы подключаются на реальном API." } }
        : request("GET", "/admin/models"),
    addModel: async (input: AddPlatformModelInput): Promise<Result<PlatformModel>> =>
      process.env.NEXT_PUBLIC_DEV_FIXTURES === "1" ? DEMO_ONLY : request("POST", "/admin/models", input),
    activateModel: async (id: string): Promise<Result<PlatformModel>> =>
      process.env.NEXT_PUBLIC_DEV_FIXTURES === "1" ? DEMO_ONLY : request("POST", `/admin/models/${encodeURIComponent(id)}/activate`),
    checkModel: async (id: string): Promise<Result<PlatformModel>> =>
      process.env.NEXT_PUBLIC_DEV_FIXTURES === "1" ? DEMO_ONLY : request("POST", `/admin/models/${encodeURIComponent(id)}/check`),
    deleteModel: async (id: string): Promise<Result<{ ok: true }>> =>
      process.env.NEXT_PUBLIC_DEV_FIXTURES === "1" ? DEMO_ONLY : request("DELETE", `/admin/models/${encodeURIComponent(id)}`),
    /** idempotencyKey создаётся ОДИН раз на открытие диалога: повтор/двойной клик с тем же ключом не начислит кредиты второй раз. */
    issueCredits: (input: { email: string; amount: number; reason: string; idempotencyKey?: string }) =>
      pick<{ ok: true }>((m) => m.issueCredits(input), () =>
        request("POST", "/admin/credits/issue", { ...input, idempotencyKey: input.idempotencyKey ?? crypto.randomUUID() })),
    flags: () => pick<FeatureFlag[]>((m) => m.flags(), () => request("GET", "/admin/flags")),
    setFlag: (key: string, enabled: boolean) =>
      pick<FeatureFlag[]>((m) => m.setFlag(key, enabled), () => request("PUT", `/admin/flags/${encodeURIComponent(key)}`, { enabled })),
    killSwitch: () => pick<{ executionEnabled: boolean }>((m) => m.killSwitch(), () => request("GET", "/admin/kill-switch")),
    setKillSwitch: (executionEnabled: boolean) =>
      pick<{ executionEnabled: boolean }>((m) => m.setKillSwitch(executionEnabled), () =>
        request("PUT", "/admin/kill-switch", { executionEnabled })),
  },
};
