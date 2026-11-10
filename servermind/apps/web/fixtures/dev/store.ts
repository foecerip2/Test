/**
 * DEV-ФИКСТУРЫ: in-memory «бэкенд» для разработки интерфейса. Ничего не выполняется на серверах.
 * Любой «результат выполнения» здесь — симуляция и помечается в тексте как [демо].
 * Сценарии для проверки состояний: ?demo=loading | error | empty | nohistory
 */
import type {
  ActionPlan, AiKey, AuditEvent, Balance, ChatMessage, DeployTemplate, Deployment, ErrorCode, FeatureFlag, Invite,
  JobEvent, LedgerEntry, Me, MetricSample, Operation, PlanStep, Provider, Result, ServerSummary, SessionInfo,
} from "@/lib/types";
import { computePlanHash, planRisk } from "@/lib/plan";
import { maskKey } from "@/lib/validation";
import type { DeployInput, PreflightCheck, Policy, ProbeResult, VerifyResult } from "@/lib/api";
import { DEMO_HISTORY_BASE, DEMO_LOG_LINES, DEMO_PUBLIC_KEY, TEMPLATES, demoSeries, iso, seedServers } from "./data";

type Scenario = "ok" | "loading" | "error" | "empty" | "nohistory";
const scenario = (): Scenario => {
  if (typeof window === "undefined") return "ok";
  const v = new URLSearchParams(window.location.search).get("demo");
  return v === "loading" || v === "error" || v === "empty" || v === "nohistory" ? v : "ok";
};

const listeners = new Set<() => void>();
export function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
const emit = () => listeners.forEach((l) => l());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let idCounter = 100;
const uid = (p: string) => `${p}_${(++idCounter).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

const ok = <T,>(data: T): Result<T> => ({ ok: true, data });
const fail = <T,>(code: ErrorCode, message: string): Result<T> => ({ ok: false, code, message });

async function gate<T>(fn: () => T | Promise<T> | Result<T> | Promise<Result<T>>, latency = 220): Promise<Result<T>> {
  const sc = scenario();
  if (sc === "loading") { await sleep(120_000); }
  await sleep(latency);
  if (sc === "error") return fail("backend_unavailable", "[демо-сценарий error] Имитация недоступного бэкенда.");
  const out = await fn();
  if (out && typeof out === "object" && "ok" in (out as object) && typeof (out as { ok: unknown }).ok === "boolean") return out as Result<T>;
  return ok(out as T);
}

// ───────── состояние ─────────
interface State {
  servers: ServerSummary[];
  operations: Operation[];
  plans: ActionPlan[];
  messages: Record<string, ChatMessage[]>;
  keys: AiKey[];
  ledger: LedgerEntry[];
  mode: "byok" | "credits";
  deployments: Deployment[];
  invites: Invite[];
  audit: AuditEvent[];
  flags: FeatureFlag[];
  executionEnabled: boolean;
  sessions: SessionInfo[];
  policy: Policy;
  pending2fa: boolean;
}
const timers = new Map<string, ReturnType<typeof setTimeout>[]>();
let state: State | null = null;
let seeding: Promise<State> | null = null;

async function getState(): Promise<State> {
  if (state) return state;
  if (!seeding) seeding = seed().then((s) => (state = s));
  return seeding;
}

function waitingPlanSteps(): PlanStep[] {
  return [
    {
      id: "s1", tool: "docker.install", title: "Установить Docker Engine и Compose-плагин", risk: "R3", optional: false, enabled: true,
      params: { channel: "stable", source: "официальный apt-репозиторий Docker", add_user_to_docker_group: false },
      expectedChange: "Добавится apt-репозиторий, будут установлены пакеты docker-ce, docker-compose-plugin; запустится служба docker.",
      verify: "docker --version; systemctl is-active docker",
      rollback: "Автоматического отката нет: пакеты удаляются вручную (apt remove).",
    },
    {
      id: "s2", tool: "app.deploy_compose", title: "Запустить шаблон «Web-приложение»", risk: "R3", optional: false, enabled: true,
      params: { template: "web-app", image: "registry.servermind.example/demo/web:1.0.0", port: 8080, read_only_rootfs: true, privileged: false },
      expectedChange: "Создаётся проект Compose из проверенного шаблона; контейнер слушает 127.0.0.1:8080.",
      verify: "docker compose ps — контейнер в состоянии running (healthy)",
      rollback: "docker compose down — данные тома сохраняются.",
    },
    {
      id: "s3", tool: "http.healthcheck", title: "Проверить доступность приложения", risk: "R1", optional: true, enabled: true,
      params: { url: "http://127.0.0.1:8080/healthz", expect_status: 200, timeout_s: 10 },
      expectedChange: "Изменений нет — только чтение.",
      verify: "HTTP 200 в течение 10 с",
      rollback: "Не требуется.",
    },
  ];
}

async function makePlan(p: Omit<ActionPlan, "canonicalHash" | "revision" | "status" | "source">): Promise<ActionPlan> {
  const plan: ActionPlan = { ...p, revision: 1, status: "waiting_approval", canonicalHash: "", source: "demo" };
  plan.canonicalHash = await computePlanHash(plan);
  return plan;
}

function makeOperationForPlan(plan: ActionPlan, actor: string): Operation {
  return {
    id: `op_${plan.id}`, planId: plan.id, title: plan.title, serverId: plan.serverId, serverName: plan.serverName,
    status: "waiting_approval", risk: planRisk(plan), actor, createdAt: plan.createdAt, startedAt: null, finishedAt: null,
    stepsDone: 0, stepsTotal: plan.steps.filter((s) => s.enabled).length, events: [
      { id: uid("ev"), at: plan.createdAt, level: "info", message: "План создан, ожидает подтверждения владельца." },
    ], source: "demo",
  };
}

async function seed(): Promise<State> {
  const servers = scenario() === "empty" ? [] : seedServers();
  const web1 = servers.find((s) => s.id === "srv_demo_web1");
  const operations: Operation[] = [];
  const plans: ActionPlan[] = [];
  if (web1) {
    const waiting = await makePlan({
      id: "plan_demo_docker", serverId: web1.id, serverName: web1.name,
      title: "Установка Docker и запуск приложения", summary: "Подготовить сервер к запуску контейнеров и развернуть проверенный шаблон web-app.",
      steps: waitingPlanSteps(), downtime: "Недоступность приложения ~1–2 минуты при запуске контейнера. Остальные службы не затрагиваются.",
      createdAt: iso(-120), expiresAt: iso(14 * 60),
    });
    plans.push(waiting);
    operations.push(makeOperationForPlan(waiting, "Демо-пользователь"));
    const ev = (offset: number, message: string, level: JobEvent["level"] = "info", step?: string): JobEvent => ({ id: uid("ev"), at: iso(offset), level, message, step });
    operations.push(
      {
        id: "op_demo_restart", planId: null, title: "Перезапуск сервиса nginx", serverId: web1.id, serverName: web1.name, status: "succeeded",
        risk: "R2", actor: "Демо-пользователь", createdAt: iso(-3600 * 5), startedAt: iso(-3600 * 5 + 20), finishedAt: iso(-3600 * 5 + 31),
        stepsDone: 2, stepsTotal: 2, source: "demo",
        events: [ev(-3600 * 5 + 20, "[демо] Шаг 1/2: service.restart nginx", "info", "s1"), ev(-3600 * 5 + 29, "[демо] nginx.service: active (running)", "info", "s1"), ev(-3600 * 5 + 31, "[демо] Шаг 2/2: проверка HTTP 200 — успешно", "info", "s2")],
      },
      {
        id: "op_demo_logs", planId: null, title: "Просмотр логов nginx", serverId: web1.id, serverName: web1.name, status: "succeeded",
        risk: "R0", actor: "AI-ассистент (read-only)", createdAt: iso(-3600 * 5 - 300), startedAt: iso(-3600 * 5 - 299), finishedAt: iso(-3600 * 5 - 297),
        stepsDone: 1, stepsTotal: 1, source: "demo",
        events: [ev(-3600 * 5 - 298, "[демо] service.logs unit=nginx lines=200 (ограничение 500 строк / 64 КиБ)")],
      },
      {
        id: "op_demo_failed", planId: null, title: "Установка Docker (попытка)", serverId: web1.id, serverName: web1.name, status: "failed",
        risk: "R3", actor: "Демо-пользователь", createdAt: iso(-86400 * 2), startedAt: iso(-86400 * 2 + 30), finishedAt: iso(-86400 * 2 + 95),
        stepsDone: 0, stepsTotal: 2, source: "demo",
        events: [
          ev(-86400 * 2 + 30, "[демо] Шаг 1/2: docker.install", "info", "s1"),
          ev(-86400 * 2 + 92, "[демо] E: Could not get lock /var/lib/dpkg/lock-frontend — другой процесс apt запущен", "error", "s1"),
          ev(-86400 * 2 + 95, "[демо] Операция остановлена. Откат не выполнялся — изменений на сервере не было.", "warn"),
        ],
      },
    );
  }
  const T = Date.now();
  return {
    servers, operations, plans, messages: {},
    keys: servers.length ? [{ id: "key_demo_openai", provider: "openai", masked: "sk-••••demo", createdAt: iso(-86400 * 3), status: "unchecked" }] : [],
    ledger: [
      { id: "led_1", at: new Date(T - 86400 * 4 * 1000).toISOString(), kind: "credit", amount: 5000, note: "Тестовые кредиты закрытой беты (выдал admin)" },
      { id: "led_2", at: new Date(T - 3600 * 30 * 1000).toISOString(), kind: "capture", amount: -37, note: "Диагностика сервера", model: "demo-model", tokensIn: 4210, tokensOut: 612 },
      { id: "led_3", at: new Date(T - 3600 * 6 * 1000).toISOString(), kind: "capture", amount: -12, note: "Объяснение ошибки 502", model: "demo-model", tokensIn: 1380, tokensOut: 240 },
    ],
    mode: "credits", deployments: [], executionEnabled: true, pending2fa: false,
    invites: [{ code: "BETA-7QK2-M9XD", createdAt: iso(-86400), expiresAt: iso(86400 * 6), usedBy: null }],
    audit: [
      { id: "au_1", at: iso(-86400 * 4), actor: "owner", action: "credits.issue", target: "demo@servermind.example · 5000 кредитов" },
      { id: "au_2", at: iso(-86400 * 2), actor: "demo@servermind.example", action: "server.add", target: "demo-web-1" },
      { id: "au_3", at: iso(-3600 * 5), actor: "demo@servermind.example", action: "plan.approve", target: "op_demo_restart" },
    ],
    flags: [
      { key: "deploy_enabled", label: "Деплой шаблонов", enabled: true, description: "Разрешает создание планов деплоя." },
      { key: "byok_enabled", label: "BYOK-ключи", enabled: true, description: "Разрешает пользователям подключать собственные ключи." },
      { key: "domain_https", label: "Настройка домена и HTTPS", enabled: false, description: "Выключено: требует DNS preflight и security review." },
    ],
    sessions: [
      { id: "ses_cur", device: "Этот браузер", lastActiveAt: iso(-5), current: true },
      { id: "ses_2", device: "Мобильный браузер (Android)", lastActiveAt: iso(-3600 * 20), current: false },
    ],
    policy: { requireApprovalR2: true, requireApprovalR3: true, planTtlMinutes: 15, maxOperationsPerDay: 20 },
  };
}

// ───────── auth ─────────
export const me = () => gate<Me>(() => ({ id: "usr_demo", email: "demo@servermind.example", name: "Демо-пользователь", role: "owner", workspace: "Личное пространство", twoFactorEnabled: true }), 120);
export const login = (email: string, password: string) => gate<{ twoFactorRequired: boolean }>(() => {
  if (password.length < 8) return fail("unauthorized", "Неверный email или пароль.");
  void email;
  return ok({ twoFactorRequired: true });
});
export const verify2fa = (code: string) => gate<{ ok: true }>(() => (/^\d{6}$/.test(code) ? ok({ ok: true as const }) : fail("validation", "Код — 6 цифр.")));
export const setup2fa = () => gate(() => ({ secret: "DEMOSECRETNOTREAL234567", otpauthUri: "otpauth://totp/ServerMind:demo?secret=DEMOSECRETNOTREAL234567&issuer=ServerMind" }), 150);
export const enable2fa = (code: string) => gate<{ ok: true }>(() => (/^\d{6}$/.test(code) ? ok({ ok: true as const }) : fail("validation", "Код — 6 цифр.")));
export const logout = () => gate<{ ok: true }>(() => ({ ok: true as const }), 80);

// ───────── servers ─────────
export const servers = () => gate(async () => (await getState()).servers.map((s) => ({ ...s })));
export const server = (id: string) => gate<ServerSummary>(async () => {
  const s = (await getState()).servers.find((x) => x.id === id);
  return s ? ok({ ...s }) : fail("not_found", "Сервер не найден или нет доступа.");
});
export const publicKey = () => gate(() => ({ key: DEMO_PUBLIC_KEY, source: "demo" as const }), 80);

export const probe = (input: { host: string; port: number }) => gate<ProbeResult>(async () => {
  const h = input.host.toLowerCase();
  if (h.endsWith(".invalid")) return fail("error", "Не удалось разрешить DNS-имя. Проверьте запись A/AAAA.");
  if (input.port === 9) return fail("error", `Соединение с ${input.host}:${input.port} отклонено (connection refused). Проверьте порт и firewall.`);
  if (h.startsWith("timeout.")) return fail("error", "Таймаут соединения (10 с). Сервер не отвечает или порт закрыт.");
  return ok({ fingerprint: "SHA256:Qz8mR9xKpL2vTn4WcYb7HdJeA1sUf3oZiGq6NrXkP2w", keyType: "ED25519", source: "demo" as const });
}, 700);

export const addServer = (input: { name: string; host: string; port: number; username: string; fingerprint: string }) => gate<VerifyResult>(async () => {
  const st = await getState();
  if (input.host.toLowerCase().startsWith("mitm.")) return fail("error", "Отпечаток ключа сервера не совпал с подтверждённым. Подключение заблокировано: возможна подмена сервера.");
  if (input.host.toLowerCase().startsWith("nokey.")) return fail("error", "Сервер отклонил ключ ServerMind. Добавьте публичный ключ в ~/.ssh/authorized_keys пользователя " + input.username + ".");
  const s: ServerSummary = {
    id: uid("srv"), name: input.name, host: input.host, port: input.port, username: input.username, os: "Ubuntu 24.04.1 LTS",
    status: "online", lastCheckedAt: iso(0), lastSuccessAt: iso(0), uptimeSeconds: 86400 * 2, cpuPercent: 6, ramUsedMb: 710, ramTotalMb: 3912,
    diskUsedGb: 5.4, diskTotalGb: 38.7, fingerprint: input.fingerprint, services: [{ name: "ssh", state: "active", managed: false }], source: "demo",
  };
  st.servers.push(s);
  st.audit.unshift({ id: uid("au"), at: iso(0), actor: "demo@servermind.example", action: "server.add", target: s.name });
  emit();
  return ok({ os: s.os ?? "—", server: { ...s } });
}, 900);

export const recheck = (id: string) => gate<ServerSummary>(async () => {
  const st = await getState();
  const s = st.servers.find((x) => x.id === id);
  if (!s) return fail("not_found", "Сервер не найден.");
  if (s.status === "offline") { s.lastCheckedAt = iso(0); emit(); return fail("error", "Сервер по-прежнему недоступен. Последняя успешная проверка сохранена."); }
  s.lastCheckedAt = iso(0); s.lastSuccessAt = iso(0); emit();
  return ok({ ...s });
}, 900);

export const logs = (id: string, unit: string) => gate<{ lines: string[]; fetchedAt: string; source: "demo" }>(async () => {
  const s = (await getState()).servers.find((x) => x.id === id);
  if (!s) return fail("not_found", "Сервер не найден.");
  if (s.status === "offline") return fail("error", "Сервер недоступен — логи получить нельзя.");
  return ok({ lines: DEMO_LOG_LINES[unit] ?? DEMO_LOG_LINES.default ?? [], fetchedAt: iso(0), source: "demo" as const });
}, 500);

// ───────── assistant ─────────
export const history = (serverId: string) => gate<ChatMessage[]>(async () => [...((await getState()).messages[serverId] ?? [])], 150);

export const send = (serverId: string, text: string) => gate<ChatMessage[]>(async () => {
  const st = await getState();
  const s = st.servers.find((x) => x.id === serverId);
  if (!s) return fail("not_found", "Выберите сервер.");
  if (st.mode === "byok" && st.keys.length === 0) return fail("forbidden", "Не подключён ключ провайдера. Добавьте ключ в «Биллинг» или переключитесь на кредиты.");
  const bal = st.ledger.reduce((a, e) => a + e.amount, 0);
  if (st.mode === "credits" && bal <= 0) return fail("forbidden", "Недостаточно кредитов. Обратитесь к администратору беты.");
  const list = (st.messages[serverId] ??= []);
  const user: ChatMessage = { id: uid("m"), role: "user", text, createdAt: iso(0) };
  list.push(user);
  const wantsFix = /502|ошибк|не работает|упал|недоступ|перезапуст|restart/i.test(text);
  const tools = [
    { id: uid("t"), tool: "server.facts", args: `server=${s.name}`, status: "done" as const, summary: s.os ? `${s.os}, uptime ${Math.round((s.uptimeSeconds ?? 0) / 86400)} д` : "ОС не определена" },
    { id: uid("t"), tool: "service.status", args: `units=${s.services.map((x) => x.name).join(",") || "—"}`, status: "done" as const, summary: s.services.map((x) => `${x.name}: ${x.state}`).join("; ") || "нет данных" },
  ];
  let reply: ChatMessage;
  const failed = s.services.find((x) => x.state === "failed");
  if (wantsFix && failed) {
    tools.push({ id: uid("t"), tool: "service.logs", args: `unit=${failed.name} lines=200`, status: "done" as const, summary: "найдено fatal: database pool exhausted" });
    const plan = await makePlan({
      id: uid("plan"), serverId: s.id, serverName: s.name, title: `Перезапуск сервиса ${failed.name}`,
      summary: `Сервис ${failed.name} остановился (exit 1), nginx получает отказ upstream и отвечает 502.`,
      steps: [
        { id: "s1", tool: "service.restart", title: `Перезапустить ${failed.name}.service`, risk: "R2", optional: false, enabled: true, params: { unit: failed.name }, expectedChange: `Служба ${failed.name} будет остановлена и запущена заново.`, verify: `systemctl is-active ${failed.name}`, rollback: "Откат не требуется: повторный перезапуск безопасен." },
        { id: "s2", tool: "http.healthcheck", title: "Проверить, что сайт отвечает 200", risk: "R1", optional: true, enabled: true, params: { url: "http://127.0.0.1:8080/healthz", expect_status: 200 }, expectedChange: "Изменений нет — только чтение.", verify: "HTTP 200", rollback: "Не требуется." },
      ],
      downtime: "Приложение недоступно ~5–10 секунд во время перезапуска.", createdAt: iso(0), expiresAt: iso(15 * 60),
    });
    st.plans.push(plan);
    st.operations.unshift(makeOperationForPlan(plan, "Демо-пользователь"));
    reply = {
      id: uid("m"), role: "assistant", demo: true, createdAt: iso(1), tools,
      text: `Причина 502, вероятнее всего, в сервисе ${failed.name}: он завершился с ошибкой, а nginx не может подключиться к upstream. Я ничего не менял на сервере — это только чтение.`,
      observed: [`${failed.name}.service — failed (exit 1)`, "В логах: «fatal: database pool exhausted, exiting»", "nginx: connect() failed (111: Connection refused) while connecting to upstream"],
      proposal: { title: plan.title, steps: plan.steps.map((x) => x.title), planId: plan.id },
    };
  } else {
    const cpu = s.cpuPercent == null ? "нет данных" : `${s.cpuPercent}%`;
    reply = {
      id: uid("m"), role: "assistant", demo: true, createdAt: iso(1), tools,
      text: s.status === "offline"
        ? "Сервер сейчас недоступен: данных о нагрузке нет, последняя успешная проверка сохранена. Проверьте сеть и firewall у провайдера."
        : `По данным последней проверки: CPU ${cpu}, диск ${s.diskUsedGb} из ${s.diskTotalGb} ГБ. Критичных проблем в выбранных показателях не вижу. Опишите симптом (например, «сайт отвечает 502»), и я подготовлю план.`,
      observed: s.status === "offline" ? [] : [`CPU ${cpu}`, `RAM ${s.ramUsedMb} из ${s.ramTotalMb} МБ`, `Диск ${s.diskUsedGb} из ${s.diskTotalGb} ГБ`],
    };
  }
  list.push(reply);
  if (st.mode === "credits") {
    const cost = wantsFix ? 14 : 6;
    st.ledger.push({ id: uid("led"), at: iso(1), kind: "capture", amount: -cost, note: wantsFix ? "Диагностика (демо)" : "Ответ (демо)", model: "demo-model", tokensIn: 1200, tokensOut: 300 });
  }
  emit();
  return ok([user, reply]);
}, 1100);

// ───────── operations & plans ─────────
export const operations = () => gate(async () => (await getState()).operations.map((o) => ({ ...o })));
export const operation = (id: string) => gate<Operation>(async () => {
  const o = (await getState()).operations.find((x) => x.id === id);
  return o ? ok({ ...o, events: [...o.events] }) : fail("not_found", "Операция не найдена.");
});
export const plan = (id: string) => gate<ActionPlan>(async () => {
  const st = await getState();
  const p = st.plans.find((x) => x.id === id);
  if (!p) return fail("not_found", "План не найден.");
  if (p.status === "waiting_approval" && Date.parse(p.expiresAt) < Date.now()) {
    p.status = "expired";
    const o = st.operations.find((x) => x.planId === p.id);
    if (o) { o.status = "expired"; o.finishedAt = iso(0); }
  }
  return ok({ ...p, steps: p.steps.map((s) => ({ ...s })) });
}, 150);

export const setStepEnabled = (id: string, stepId: string, enabled: boolean) => gate<ActionPlan>(async () => {
  const st = await getState();
  const p = st.plans.find((x) => x.id === id);
  if (!p) return fail("not_found", "План не найден.");
  if (p.status !== "waiting_approval") return fail("forbidden", "План уже нельзя изменить.");
  const step = p.steps.find((s) => s.id === stepId);
  if (!step) return fail("not_found", "Шаг не найден.");
  if (!step.optional) return fail("forbidden", "Обязательный шаг нельзя отключить.");
  step.enabled = enabled;
  p.revision += 1; // любое изменение плана → новая ревизия и новый хеш → прежнее подтверждение недействительно
  p.canonicalHash = await computePlanHash(p);
  const o = st.operations.find((x) => x.planId === p.id);
  if (o) { o.stepsTotal = p.steps.filter((s) => s.enabled).length; o.risk = planRisk(p); o.events.push({ id: uid("ev"), at: iso(0), level: "info", message: `План изменён: ревизия ${p.revision}. Предыдущее подтверждение сброшено.` }); }
  emit();
  return ok({ ...p, steps: p.steps.map((s) => ({ ...s })) });
}, 120);

export const approve = (id: string, sig: { hash: string; revision: number }) => gate<Operation>(async () => {
  const st = await getState();
  const p = st.plans.find((x) => x.id === id);
  const o = st.operations.find((x) => x.planId === id);
  if (!p || !o) return fail("not_found", "План не найден.");
  if (!st.executionEnabled) return fail("forbidden", "Исполнение отключено администратором (kill switch).");
  if (p.status !== "waiting_approval") return fail("forbidden", "План уже обработан.");
  if (Date.parse(p.expiresAt) < Date.now()) { p.status = "expired"; o.status = "expired"; o.finishedAt = iso(0); emit(); return fail("forbidden", "Срок действия плана истёк. Создайте план заново."); }
  if (sig.revision !== p.revision || sig.hash !== p.canonicalHash) return fail("validation", "План изменился после просмотра. Проверьте его и подтвердите снова.");
  const server = st.servers.find((s) => s.id === p.serverId);
  if (!server || server.status !== "online") return fail("error", "Сервер недоступен — исполнение невозможно.");
  p.status = "approved";
  o.status = "running"; o.startedAt = iso(0);
  o.events.push({ id: uid("ev"), at: iso(0), level: "info", message: `Подтверждено. Хеш ${p.canonicalHash.slice(0, 12)}…, ревизия ${p.revision}. [демо] Команды на сервере НЕ выполняются — идёт симуляция.` });
  st.audit.unshift({ id: uid("au"), at: iso(0), actor: "demo@servermind.example", action: "plan.approve", target: o.id });
  runSimulation(st, o, p);
  emit();
  return ok({ ...o });
}, 400);

function runSimulation(st: State, o: Operation, p: ActionPlan) {
  const steps = p.steps.filter((s) => s.enabled);
  const list: ReturnType<typeof setTimeout>[] = [];
  steps.forEach((step, i) => {
    list.push(setTimeout(() => {
      o.events.push({ id: uid("ev"), at: iso(0), level: "info", step: step.id, message: `[демо] Шаг ${i + 1}/${steps.length}: ${step.tool} — ${step.title}` });
      emit();
    }, 1200 + i * 2600));
    list.push(setTimeout(() => {
      o.stepsDone = i + 1;
      o.events.push({ id: uid("ev"), at: iso(0), level: "info", step: step.id, message: `[демо] Проверка: ${step.verify} — симуляция успешна` });
      if (i === steps.length - 1) {
        o.status = "succeeded"; o.finishedAt = iso(0);
        o.events.push({ id: uid("ev"), at: iso(0), level: "info", message: "[демо] Операция завершена. Реальных изменений на сервере не было." });
        const dep = st.deployments.find((d) => d.operationId === o.id);
        if (dep) dep.status = "succeeded";
      }
      emit();
    }, 1200 + i * 2600 + 1500));
  });
  timers.set(o.id, list);
}

export const cancel = (id: string) => gate<Operation>(async () => {
  const st = await getState();
  const o = st.operations.find((x) => x.id === id);
  if (!o) return fail("not_found", "Операция не найдена.");
  if (o.status !== "running" && o.status !== "queued" && o.status !== "waiting_approval") return fail("forbidden", "Операцию уже нельзя отменить.");
  timers.get(id)?.forEach(clearTimeout);
  o.status = "cancelled"; o.finishedAt = iso(0);
  o.events.push({ id: uid("ev"), at: iso(0), level: "warn", message: "Операция отменена. Отмена не равнозначна откату: уже выполненные шаги не откатываются." });
  const p = st.plans.find((x) => x.id === o.planId);
  if (p && p.status === "waiting_approval") p.status = "rejected";
  emit();
  return ok({ ...o });
}, 200);

export const reject = (id: string) => gate<ActionPlan>(async () => {
  const st = await getState();
  const p = st.plans.find((x) => x.id === id);
  if (!p) return fail("not_found", "План не найден.");
  if (p.status !== "waiting_approval") return fail("forbidden", "План уже обработан.");
  p.status = "rejected";
  const o = st.operations.find((x) => x.planId === id);
  if (o) { o.status = "cancelled"; o.finishedAt = iso(0); o.events.push({ id: uid("ev"), at: iso(0), level: "info", message: "План отклонён владельцем. Изменений не вносилось." }); }
  st.audit.unshift({ id: uid("au"), at: iso(0), actor: "demo@servermind.example", action: "plan.reject", target: id });
  emit();
  return ok({ ...p });
}, 200);

// ───────── deploy ─────────
export const templates = () => gate<DeployTemplate[]>(() => TEMPLATES, 120);
export const deployments = () => gate(async () => (await getState()).deployments.map((d) => ({ ...d })));

export const preflight = (input: DeployInput) => gate<PreflightCheck[]>(async () => {
  const st = await getState();
  const s = st.servers.find((x) => x.id === input.serverId);
  if (!s) return fail("not_found", "Сервер не найден.");
  const diskPct = s.diskUsedGb != null && s.diskTotalGb ? (s.diskUsedGb / s.diskTotalGb) * 100 : null;
  const checks: PreflightCheck[] = [
    { id: "online", label: "Сервер доступен", status: s.status === "online" ? "pass" : "fail", detail: s.status === "online" ? "Последняя проверка успешна." : "Сервер офлайн — деплой невозможен.", blocking: true },
    { id: "disk", label: "Свободное место на диске", status: diskPct == null ? "warn" : diskPct >= 90 ? "fail" : diskPct >= 75 ? "warn" : "pass", detail: diskPct == null ? "Нет данных." : `Занято ${Math.round(diskPct)}%. ${diskPct >= 90 ? "Ресурсоёмкие операции заблокированы при 90%." : diskPct >= 75 ? "Предупреждение: больше 75%." : "Достаточно."}`, blocking: diskPct != null && diskPct >= 90 },
    { id: "docker", label: "Docker установлен", status: s.services.some((x) => x.name === "docker" && x.state === "active") ? "pass" : "warn", detail: s.services.some((x) => x.name === "docker" && x.state === "active") ? "Служба docker активна." : "Docker не запущен — в план будет добавлена установка (R3, требует подтверждения).", blocking: false },
    { id: "dns", label: "DNS указывает на сервер", status: input.domain ? (input.domain.endsWith(".servermind.example") ? "warn" : "pass") : "warn", detail: input.domain ? (input.domain.endsWith(".servermind.example") ? "[демо] Домен-заглушка не разрешается. HTTPS не будет настроен." : "[демо] A-запись совпала с IP сервера.") : "Домен не указан — приложение будет доступно только на localhost сервера.", blocking: false },
  ];
  return ok(checks);
}, 800);

export const createDeployPlan = (input: DeployInput) => gate<ActionPlan>(async () => {
  const st = await getState();
  const s = st.servers.find((x) => x.id === input.serverId);
  const tpl = TEMPLATES.find((t) => t.id === input.templateId);
  if (!s || !tpl || !tpl.available) return fail("validation", "Выберите доступный шаблон и сервер.");
  const needDocker = !s.services.some((x) => x.name === "docker" && x.state === "active");
  const steps: PlanStep[] = [];
  if (needDocker) steps.push(waitingPlanSteps()[0]!);
  steps.push({
    id: "s2", tool: "app.deploy_compose", title: `Запустить шаблон «${tpl.name}»`, risk: "R3", optional: false, enabled: true,
    params: { template: tpl.id, port: tpl.port, env_keys: input.envKeys.join(",") || "(нет)", read_only_rootfs: true, privileged: false },
    expectedChange: "Создаётся проект Compose из проверенного шаблона. Значения переменных окружения в план и журнал не попадают.",
    verify: "docker compose ps — running (healthy)", rollback: "docker compose down — данные тома сохраняются.",
  });
  steps.push({ ...waitingPlanSteps()[2]!, id: "s3" });
  const pl = await makePlan({
    id: uid("plan"), serverId: s.id, serverName: s.name, title: `Деплой «${tpl.name}»`, summary: `Развернуть шаблон на ${s.name}${input.domain ? `, домен ${input.domain}` : ""}.`,
    steps, downtime: "Новое приложение; существующие службы не затрагиваются.", createdAt: iso(0), expiresAt: iso(15 * 60),
  });
  st.plans.push(pl);
  const op = makeOperationForPlan(pl, "Демо-пользователь");
  st.operations.unshift(op);
  st.deployments.unshift({ id: uid("dep"), serverId: s.id, serverName: s.name, template: tpl.name, domain: input.domain || null, status: "waiting_approval", createdAt: iso(0), operationId: op.id, source: "demo" });
  emit();
  return ok({ ...pl });
}, 600);

// ───────── monitoring ─────────
export const history_ = (serverId: string, hours: number) => gate<{ samples: MetricSample[]; intervalSec: number; source: "demo" }>(async () => {
  const st = await getState();
  const s = st.servers.find((x) => x.id === serverId);
  if (!s) return fail("not_found", "Сервер не найден.");
  const base = DEMO_HISTORY_BASE[serverId];
  if (!base || scenario() === "nohistory") return ok({ samples: [], intervalSec: 900, source: "demo" as const });
  const all = demoSeries(base.seed, 96 * 7, base);
  return ok({ samples: all.slice(-Math.min(all.length, hours * 4)), intervalSec: 900, source: "demo" as const });
}, 350);

// ───────── billing ─────────
export const balance = () => gate<Balance>(async () => {
  const st = await getState();
  return { available: st.ledger.reduce((a, e) => a + e.amount, 0), reserved: 0, dailyCap: 500, monthlyCap: 5000 };
}, 150);
export const ledger = () => gate(async () => [...(await getState()).ledger].reverse());
export const keys = () => gate(async () => [...(await getState()).keys]);
export const addKey = (input: { provider: Provider; key: string; skipValidation: boolean }) => gate<AiKey>(async () => {
  const st = await getState();
  if (input.key.trim().length < 12) return fail("validation", "Ключ слишком короткий.");
  // значение ключа не сохраняется нигде — только маска
  const k: AiKey = { id: uid("key"), provider: input.provider, masked: maskKey(input.key), createdAt: iso(0), status: input.skipValidation ? "unchecked" : "valid" };
  st.keys.push(k); emit();
  return ok(k);
}, 800);
export const deleteKey = (id: string) => gate<{ ok: true }>(async () => {
  const st = await getState();
  st.keys = st.keys.filter((k) => k.id !== id); emit();
  return { ok: true as const };
}, 200);
export const getMode = () => gate(async () => ({ mode: (await getState()).mode }), 80);
export const setMode = (mode: "byok" | "credits") => gate(async () => { (await getState()).mode = mode; emit(); return { mode }; }, 120);

// ───────── settings ─────────
export const sessions = () => gate(async () => [...(await getState()).sessions]);
export const revokeSession = (id: string) => gate<{ ok: true }>(async () => {
  const st = await getState();
  const s = st.sessions.find((x) => x.id === id);
  if (s?.current) return fail("forbidden", "Текущую сессию завершите через «Выйти».");
  st.sessions = st.sessions.filter((x) => x.id !== id); emit();
  return ok({ ok: true as const });
}, 200);
export const policy = () => gate(async () => ({ ...(await getState()).policy }), 100);
export const setPolicy = (p: Partial<Policy>) => gate<Policy>(async () => {
  const st = await getState();
  st.policy = { ...st.policy, ...p, requireApprovalR2: true, requireApprovalR3: true }; // обязательные подтверждения отключить нельзя
  emit();
  return { ...st.policy };
}, 150);
export const deleteSecrets = (serverId: string) => gate<{ ok: true }>(async () => {
  const st = await getState();
  const s = st.servers.find((x) => x.id === serverId);
  if (!s) return fail("not_found", "Сервер не найден.");
  st.servers = st.servers.filter((x) => x.id !== serverId);
  st.audit.unshift({ id: uid("au"), at: iso(0), actor: "demo@servermind.example", action: "server.secrets.delete", target: s.name });
  emit();
  return ok({ ok: true as const });
}, 400);

// ───────── admin ─────────
export const invites = () => gate(async () => [...(await getState()).invites]);
export const createInvite = () => gate<Invite>(async () => {
  const st = await getState();
  const part = () => Math.random().toString(36).slice(2, 6).toUpperCase();
  const inv: Invite = { code: `BETA-${part()}-${part()}`, createdAt: iso(0), expiresAt: iso(86400 * 7), usedBy: null };
  st.invites.unshift(inv);
  st.audit.unshift({ id: uid("au"), at: iso(0), actor: "owner", action: "invite.create", target: inv.code });
  emit();
  return inv;
}, 300);
export const audit = () => gate(async () => [...(await getState()).audit]);
export const issueCredits = (input: { email: string; amount: number; reason: string }) => gate<{ ok: true }>(async () => {
  const st = await getState();
  if (!Number.isInteger(input.amount) || input.amount <= 0 || input.amount > 10000) return fail("validation", "Сумма — целое от 1 до 10 000.");
  if (input.reason.trim().length < 5) return fail("validation", "Укажите причину (для аудита).");
  st.ledger.push({ id: uid("led"), at: iso(0), kind: "credit", amount: input.amount, note: `Тестовые кредиты (admin): ${input.reason.trim()}` });
  st.audit.unshift({ id: uid("au"), at: iso(0), actor: "owner", action: "credits.issue", target: `${input.email} · ${input.amount}` });
  emit();
  return ok({ ok: true as const });
}, 400);
export const flags = () => gate(async () => (await getState()).flags.map((f) => ({ ...f })));
export const setFlag = (key: string, enabled: boolean) => gate<FeatureFlag[]>(async () => {
  const st = await getState();
  const f = st.flags.find((x) => x.key === key);
  if (!f) return fail("not_found", "Флаг не найден.");
  f.enabled = enabled;
  st.audit.unshift({ id: uid("au"), at: iso(0), actor: "owner", action: "flag.set", target: `${key}=${enabled}` });
  emit();
  return ok(st.flags.map((x) => ({ ...x })));
}, 150);
export const killSwitch = () => gate(async () => ({ executionEnabled: (await getState()).executionEnabled }), 80);
export const setKillSwitch = (executionEnabled: boolean) => gate(async () => {
  const st = await getState();
  st.executionEnabled = executionEnabled;
  st.audit.unshift({ id: uid("au"), at: iso(0), actor: "owner", action: "kill_switch", target: executionEnabled ? "execution enabled" : "execution DISABLED" });
  emit();
  return { executionEnabled };
}, 200);
