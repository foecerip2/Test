module.exports = [
"[project]/fixtures/dev/data.ts [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

/**
 * DEV-ФИКСТУРЫ. Синтетические данные для разработки дизайна. Не отражают реальные серверы.
 * Подключаются только при NEXT_PUBLIC_DEV_FIXTURES=1 (см. lib/api/index.ts); интерфейс при этом
 * всегда показывает ribbon «Демо-данные». IP — из диапазона документации 203.0.113.0/24 (RFC 5737).
 */ __turbopack_context__.s([
    "DEMO_HISTORY_BASE",
    ()=>DEMO_HISTORY_BASE,
    "DEMO_LOG_LINES",
    ()=>DEMO_LOG_LINES,
    "DEMO_PUBLIC_KEY",
    ()=>DEMO_PUBLIC_KEY,
    "NOW",
    ()=>NOW,
    "TEMPLATES",
    ()=>TEMPLATES,
    "demoSeries",
    ()=>demoSeries,
    "iso",
    ()=>iso,
    "seedServers",
    ()=>seedServers
]);
const NOW = ()=>Date.now();
const iso = (offsetSec)=>new Date(Date.now() + offsetSec * 1000).toISOString();
function mulberry32(seed) {
    let a = seed;
    return ()=>{
        a |= 0;
        a = a + 0x6d2b79f5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}
function demoSeries(seed, points, base) {
    const rnd = mulberry32(seed);
    const stepMs = 15 * 60 * 1000;
    const end = Math.floor(Date.now() / stepMs) * stepMs;
    const out = [];
    let cpu = base.cpu;
    for(let i = points - 1; i >= 0; i--){
        const t = end - i * stepMs;
        cpu = Math.max(2, Math.min(96, cpu + (rnd() - 0.5) * 14 + (base.cpu - cpu) * 0.15));
        const ram = Math.max(10, Math.min(95, base.ram + Math.sin((points - i) / 9) * 4 + (rnd() - 0.5) * 2));
        const disk = Math.max(5, Math.min(99, base.disk - i * 0.01 + (rnd() - 0.5) * 0.1));
        out.push({
            t: new Date(t).toISOString(),
            cpu: +cpu.toFixed(1),
            ram: +ram.toFixed(1),
            disk: +disk.toFixed(1)
        });
    }
    return out;
}
const svc = (name, state, managed = false)=>({
        name,
        state,
        managed
    });
function seedServers() {
    return [
        {
            id: "srv_demo_web1",
            name: "demo-web-1",
            host: "203.0.113.10",
            port: 22,
            username: "servermind",
            os: "Ubuntu 24.04.1 LTS",
            status: "online",
            lastCheckedAt: iso(-42),
            lastSuccessAt: iso(-42),
            uptimeSeconds: 18 * 86400 + 5 * 3600,
            cpuPercent: 24,
            ramUsedMb: 1638,
            ramTotalMb: 4096,
            diskUsedGb: 12.8,
            diskTotalGb: 40,
            fingerprint: "SHA256:Qz8mR9xKpL2vTn4WcYb7HdJeA1sUf3oZiGq6NrXkP2w",
            services: [
                svc("nginx", "active"),
                svc("docker", "active"),
                svc("myapp", "failed", true),
                svc("postgresql", "active"),
                svc("ssh", "active")
            ],
            source: "demo"
        },
        {
            id: "srv_demo_stage",
            name: "demo-staging",
            host: "staging.servermind.example",
            port: 22,
            username: "servermind",
            os: "Ubuntu 24.04.1 LTS",
            status: "online",
            lastCheckedAt: iso(-95),
            lastSuccessAt: iso(-95),
            uptimeSeconds: 3 * 86400 + 7 * 3600,
            cpuPercent: 8,
            ramUsedMb: 912,
            ramTotalMb: 4096,
            diskUsedGb: 6.1,
            diskTotalGb: 40,
            fingerprint: "SHA256:b1Ke7WqPz0XcM4yTnHs9RdLfA6uVg2oJiEq3NrZkY5c",
            services: [
                svc("nginx", "active"),
                svc("docker", "inactive"),
                svc("ssh", "active")
            ],
            source: "demo"
        },
        {
            id: "srv_demo_archive",
            name: "demo-archive",
            host: "203.0.113.77",
            port: 2222,
            username: "servermind",
            os: "Ubuntu 22.04.5 LTS",
            status: "offline",
            lastCheckedAt: iso(-60),
            lastSuccessAt: iso(-3 * 3600 - 1260),
            uptimeSeconds: null,
            cpuPercent: null,
            ramUsedMb: null,
            ramTotalMb: null,
            diskUsedGb: 36.8,
            diskTotalGb: 40,
            fingerprint: "SHA256:Hd3Ye9TpW1KcM7xQnLs4RbVfA2uZg8oJiEq6NrXkP0a",
            services: [],
            source: "demo"
        }
    ];
}
const DEMO_HISTORY_BASE = {
    srv_demo_web1: {
        seed: 11,
        cpu: 26,
        ram: 40,
        disk: 32
    },
    srv_demo_stage: {
        seed: 23,
        cpu: 9,
        ram: 22,
        disk: 15
    }
};
const TEMPLATES = [
    {
        id: "web-app",
        name: "Web-приложение (контейнер)",
        port: 8080,
        available: true,
        description: "Готовый образ из реестра без привилегий: непривилегированный пользователь, read-only root FS, без host-mount. Порт 8080 за Caddy."
    },
    {
        id: "static-site",
        name: "Статический сайт",
        port: 8080,
        available: false,
        description: "Скоро: раздача статики через Caddy."
    },
    {
        id: "postgres",
        name: "PostgreSQL (управляемая БД)",
        port: 5432,
        available: false,
        description: "Скоро. Базы данных ставятся только вручную, пока не пройден security review."
    }
];
const DEMO_PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAADEVMOCK0DEMO0KEY0NOT0FOR0USE00000000 servermind-DEMO-key";
const DEMO_LOG_LINES = {
    myapp: [
        "2026-11-09T14:02:11Z myapp[2210]: listening on :8080",
        "2026-11-09T14:19:40Z myapp[2210]: error: connect ECONNREFUSED 127.0.0.1:5432",
        "2026-11-09T14:19:41Z myapp[2210]: fatal: database pool exhausted, exiting",
        "2026-11-09T14:19:41Z systemd[1]: myapp.service: Main process exited, code=exited, status=1/FAILURE",
        "2026-11-09T14:19:41Z systemd[1]: myapp.service: Failed with result 'exit-code'."
    ],
    nginx: [
        "203.0.113.55 - - [09/Nov/2026:14:20:03 +0000] \"GET / HTTP/1.1\" 502 157",
        "2026/11/09 14:20:03 [error] 811#811: *412 connect() failed (111: Connection refused) while connecting to upstream"
    ],
    default: [
        "(демо) записей нет"
    ]
};
}),
"[project]/fixtures/dev/store.ts [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

/**
 * DEV-ФИКСТУРЫ: in-memory «бэкенд» для разработки интерфейса. Ничего не выполняется на серверах.
 * Любой «результат выполнения» здесь — симуляция и помечается в тексте как [демо].
 * Сценарии для проверки состояний: ?demo=loading | error | empty | nohistory
 */ __turbopack_context__.s([
    "addKey",
    ()=>addKey,
    "addServer",
    ()=>addServer,
    "approve",
    ()=>approve,
    "audit",
    ()=>audit,
    "balance",
    ()=>balance,
    "cancel",
    ()=>cancel,
    "createDeployPlan",
    ()=>createDeployPlan,
    "createInvite",
    ()=>createInvite,
    "deleteKey",
    ()=>deleteKey,
    "deleteSecrets",
    ()=>deleteSecrets,
    "deployments",
    ()=>deployments,
    "flags",
    ()=>flags,
    "getMode",
    ()=>getMode,
    "history",
    ()=>history,
    "history_",
    ()=>history_,
    "invites",
    ()=>invites,
    "issueCredits",
    ()=>issueCredits,
    "keys",
    ()=>keys,
    "killSwitch",
    ()=>killSwitch,
    "ledger",
    ()=>ledger,
    "login",
    ()=>login,
    "logout",
    ()=>logout,
    "logs",
    ()=>logs,
    "me",
    ()=>me,
    "operation",
    ()=>operation,
    "operations",
    ()=>operations,
    "plan",
    ()=>plan,
    "policy",
    ()=>policy,
    "preflight",
    ()=>preflight,
    "probe",
    ()=>probe,
    "publicKey",
    ()=>publicKey,
    "recheck",
    ()=>recheck,
    "reject",
    ()=>reject,
    "revokeSession",
    ()=>revokeSession,
    "send",
    ()=>send,
    "server",
    ()=>server,
    "servers",
    ()=>servers,
    "sessions",
    ()=>sessions,
    "setFlag",
    ()=>setFlag,
    "setKillSwitch",
    ()=>setKillSwitch,
    "setMode",
    ()=>setMode,
    "setPolicy",
    ()=>setPolicy,
    "setStepEnabled",
    ()=>setStepEnabled,
    "subscribe",
    ()=>subscribe,
    "templates",
    ()=>templates,
    "verify2fa",
    ()=>verify2fa
]);
var __TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$plan$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/lib/plan.ts [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$validation$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/lib/validation.ts [app-ssr] (ecmascript)");
var __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__ = __turbopack_context__.i("[project]/fixtures/dev/data.ts [app-ssr] (ecmascript)");
;
;
;
const scenario = ()=>{
    if ("TURBOPACK compile-time truthy", 1) return "ok";
    //TURBOPACK unreachable
    ;
    const v = undefined;
};
const listeners = new Set();
function subscribe(cb) {
    listeners.add(cb);
    return ()=>{
        listeners.delete(cb);
    };
}
const emit = ()=>listeners.forEach((l)=>l());
const sleep = (ms)=>new Promise((r)=>setTimeout(r, ms));
let idCounter = 100;
const uid = (p)=>`${p}_${(++idCounter).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const ok = (data)=>({
        ok: true,
        data
    });
const fail = (code, message)=>({
        ok: false,
        code,
        message
    });
async function gate(fn, latency = 220) {
    const sc = scenario();
    if (sc === "loading") {
        await sleep(120_000);
    }
    await sleep(latency);
    if (sc === "error") return fail("backend_unavailable", "[демо-сценарий error] Имитация недоступного бэкенда.");
    const out = await fn();
    if (out && typeof out === "object" && "ok" in out && typeof out.ok === "boolean") return out;
    return ok(out);
}
const timers = new Map();
let state = null;
let seeding = null;
async function getState() {
    if (state) return state;
    if (!seeding) seeding = seed().then((s)=>state = s);
    return seeding;
}
function waitingPlanSteps() {
    return [
        {
            id: "s1",
            tool: "docker.install",
            title: "Установить Docker Engine и Compose-плагин",
            risk: "R3",
            optional: false,
            enabled: true,
            params: {
                channel: "stable",
                source: "официальный apt-репозиторий Docker",
                add_user_to_docker_group: false
            },
            expectedChange: "Добавится apt-репозиторий, будут установлены пакеты docker-ce, docker-compose-plugin; запустится служба docker.",
            verify: "docker --version; systemctl is-active docker",
            rollback: "Автоматического отката нет: пакеты удаляются вручную (apt remove)."
        },
        {
            id: "s2",
            tool: "app.deploy_compose",
            title: "Запустить шаблон «Web-приложение»",
            risk: "R3",
            optional: false,
            enabled: true,
            params: {
                template: "web-app",
                image: "registry.servermind.example/demo/web:1.0.0",
                port: 8080,
                read_only_rootfs: true,
                privileged: false
            },
            expectedChange: "Создаётся проект Compose из проверенного шаблона; контейнер слушает 127.0.0.1:8080.",
            verify: "docker compose ps — контейнер в состоянии running (healthy)",
            rollback: "docker compose down — данные тома сохраняются."
        },
        {
            id: "s3",
            tool: "http.healthcheck",
            title: "Проверить доступность приложения",
            risk: "R1",
            optional: true,
            enabled: true,
            params: {
                url: "http://127.0.0.1:8080/healthz",
                expect_status: 200,
                timeout_s: 10
            },
            expectedChange: "Изменений нет — только чтение.",
            verify: "HTTP 200 в течение 10 с",
            rollback: "Не требуется."
        }
    ];
}
async function makePlan(p) {
    const plan = {
        ...p,
        revision: 1,
        status: "waiting_approval",
        canonicalHash: "",
        source: "demo"
    };
    plan.canonicalHash = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$plan$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["computePlanHash"])(plan);
    return plan;
}
function makeOperationForPlan(plan, actor) {
    return {
        id: `op_${plan.id}`,
        planId: plan.id,
        title: plan.title,
        serverId: plan.serverId,
        serverName: plan.serverName,
        status: "waiting_approval",
        risk: (0, __TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$plan$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["planRisk"])(plan),
        actor,
        createdAt: plan.createdAt,
        startedAt: null,
        finishedAt: null,
        stepsDone: 0,
        stepsTotal: plan.steps.filter((s)=>s.enabled).length,
        events: [
            {
                id: uid("ev"),
                at: plan.createdAt,
                level: "info",
                message: "План создан, ожидает подтверждения владельца."
            }
        ],
        source: "demo"
    };
}
async function seed() {
    const servers = scenario() === "empty" ? [] : (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["seedServers"])();
    const web1 = servers.find((s)=>s.id === "srv_demo_web1");
    const operations = [];
    const plans = [];
    if (web1) {
        const waiting = await makePlan({
            id: "plan_demo_docker",
            serverId: web1.id,
            serverName: web1.name,
            title: "Установка Docker и запуск приложения",
            summary: "Подготовить сервер к запуску контейнеров и развернуть проверенный шаблон web-app.",
            steps: waitingPlanSteps(),
            downtime: "Недоступность приложения ~1–2 минуты при запуске контейнера. Остальные службы не затрагиваются.",
            createdAt: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(-120),
            expiresAt: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(14 * 60)
        });
        plans.push(waiting);
        operations.push(makeOperationForPlan(waiting, "Демо-пользователь"));
        const ev = (offset, message, level = "info", step)=>({
                id: uid("ev"),
                at: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(offset),
                level,
                message,
                step
            });
        operations.push({
            id: "op_demo_restart",
            planId: null,
            title: "Перезапуск сервиса nginx",
            serverId: web1.id,
            serverName: web1.name,
            status: "succeeded",
            risk: "R2",
            actor: "Демо-пользователь",
            createdAt: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(-3600 * 5),
            startedAt: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(-3600 * 5 + 20),
            finishedAt: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(-3600 * 5 + 31),
            stepsDone: 2,
            stepsTotal: 2,
            source: "demo",
            events: [
                ev(-3600 * 5 + 20, "[демо] Шаг 1/2: service.restart nginx", "info", "s1"),
                ev(-3600 * 5 + 29, "[демо] nginx.service: active (running)", "info", "s1"),
                ev(-3600 * 5 + 31, "[демо] Шаг 2/2: проверка HTTP 200 — успешно", "info", "s2")
            ]
        }, {
            id: "op_demo_logs",
            planId: null,
            title: "Просмотр логов nginx",
            serverId: web1.id,
            serverName: web1.name,
            status: "succeeded",
            risk: "R0",
            actor: "AI-ассистент (read-only)",
            createdAt: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(-3600 * 5 - 300),
            startedAt: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(-3600 * 5 - 299),
            finishedAt: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(-3600 * 5 - 297),
            stepsDone: 1,
            stepsTotal: 1,
            source: "demo",
            events: [
                ev(-3600 * 5 - 298, "[демо] service.logs unit=nginx lines=200 (ограничение 500 строк / 64 КиБ)")
            ]
        }, {
            id: "op_demo_failed",
            planId: null,
            title: "Установка Docker (попытка)",
            serverId: web1.id,
            serverName: web1.name,
            status: "failed",
            risk: "R3",
            actor: "Демо-пользователь",
            createdAt: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(-86400 * 2),
            startedAt: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(-86400 * 2 + 30),
            finishedAt: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(-86400 * 2 + 95),
            stepsDone: 0,
            stepsTotal: 2,
            source: "demo",
            events: [
                ev(-86400 * 2 + 30, "[демо] Шаг 1/2: docker.install", "info", "s1"),
                ev(-86400 * 2 + 92, "[демо] E: Could not get lock /var/lib/dpkg/lock-frontend — другой процесс apt запущен", "error", "s1"),
                ev(-86400 * 2 + 95, "[демо] Операция остановлена. Откат не выполнялся — изменений на сервере не было.", "warn")
            ]
        });
    }
    const T = Date.now();
    return {
        servers,
        operations,
        plans,
        messages: {},
        keys: servers.length ? [
            {
                id: "key_demo_openai",
                provider: "openai",
                masked: "sk-••••demo",
                createdAt: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(-86400 * 3),
                status: "unchecked"
            }
        ] : [],
        ledger: [
            {
                id: "led_1",
                at: new Date(T - 86400 * 4 * 1000).toISOString(),
                kind: "credit",
                amount: 5000,
                note: "Тестовые кредиты закрытой беты (выдал admin)"
            },
            {
                id: "led_2",
                at: new Date(T - 3600 * 30 * 1000).toISOString(),
                kind: "capture",
                amount: -37,
                note: "Диагностика сервера",
                model: "demo-model",
                tokensIn: 4210,
                tokensOut: 612
            },
            {
                id: "led_3",
                at: new Date(T - 3600 * 6 * 1000).toISOString(),
                kind: "capture",
                amount: -12,
                note: "Объяснение ошибки 502",
                model: "demo-model",
                tokensIn: 1380,
                tokensOut: 240
            }
        ],
        mode: "credits",
        deployments: [],
        executionEnabled: true,
        pending2fa: false,
        invites: [
            {
                code: "BETA-7QK2-M9XD",
                createdAt: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(-86400),
                expiresAt: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(86400 * 6),
                usedBy: null
            }
        ],
        audit: [
            {
                id: "au_1",
                at: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(-86400 * 4),
                actor: "owner",
                action: "credits.issue",
                target: "demo@servermind.example · 5000 кредитов"
            },
            {
                id: "au_2",
                at: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(-86400 * 2),
                actor: "demo@servermind.example",
                action: "server.add",
                target: "demo-web-1"
            },
            {
                id: "au_3",
                at: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(-3600 * 5),
                actor: "demo@servermind.example",
                action: "plan.approve",
                target: "op_demo_restart"
            }
        ],
        flags: [
            {
                key: "deploy_enabled",
                label: "Деплой шаблонов",
                enabled: true,
                description: "Разрешает создание планов деплоя."
            },
            {
                key: "byok_enabled",
                label: "BYOK-ключи",
                enabled: true,
                description: "Разрешает пользователям подключать собственные ключи."
            },
            {
                key: "domain_https",
                label: "Настройка домена и HTTPS",
                enabled: false,
                description: "Выключено: требует DNS preflight и security review."
            }
        ],
        sessions: [
            {
                id: "ses_cur",
                device: "Этот браузер",
                lastActiveAt: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(-5),
                current: true
            },
            {
                id: "ses_2",
                device: "Мобильный браузер (Android)",
                lastActiveAt: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(-3600 * 20),
                current: false
            }
        ],
        policy: {
            requireApprovalR2: true,
            requireApprovalR3: true,
            planTtlMinutes: 15,
            maxOperationsPerDay: 20
        }
    };
}
const me = ()=>gate(()=>({
            id: "usr_demo",
            email: "demo@servermind.example",
            name: "Демо-пользователь",
            role: "owner",
            workspace: "Личное пространство",
            twoFactorEnabled: true
        }), 120);
const login = (email, password)=>gate(()=>{
        if (password.length < 8) return fail("unauthorized", "Неверный email или пароль.");
        void email;
        return ok({
            twoFactorRequired: true
        });
    });
const verify2fa = (code)=>gate(()=>/^\d{6}$/.test(code) ? ok({
            ok: true
        }) : fail("validation", "Код — 6 цифр."));
const logout = ()=>gate(()=>({
            ok: true
        }), 80);
const servers = ()=>gate(async ()=>(await getState()).servers.map((s)=>({
                ...s
            })));
const server = (id)=>gate(async ()=>{
        const s = (await getState()).servers.find((x)=>x.id === id);
        return s ? ok({
            ...s
        }) : fail("not_found", "Сервер не найден или нет доступа.");
    });
const publicKey = ()=>gate(()=>({
            key: __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["DEMO_PUBLIC_KEY"],
            source: "demo"
        }), 80);
const probe = (input)=>gate(async ()=>{
        const h = input.host.toLowerCase();
        if (h.endsWith(".invalid")) return fail("error", "Не удалось разрешить DNS-имя. Проверьте запись A/AAAA.");
        if (input.port === 9) return fail("error", `Соединение с ${input.host}:${input.port} отклонено (connection refused). Проверьте порт и firewall.`);
        if (h.startsWith("timeout.")) return fail("error", "Таймаут соединения (10 с). Сервер не отвечает или порт закрыт.");
        return ok({
            fingerprint: "SHA256:Qz8mR9xKpL2vTn4WcYb7HdJeA1sUf3oZiGq6NrXkP2w",
            keyType: "ED25519",
            source: "demo"
        });
    }, 700);
const addServer = (input)=>gate(async ()=>{
        const st = await getState();
        if (input.host.toLowerCase().startsWith("mitm.")) return fail("error", "Отпечаток ключа сервера не совпал с подтверждённым. Подключение заблокировано: возможна подмена сервера.");
        if (input.host.toLowerCase().startsWith("nokey.")) return fail("error", "Сервер отклонил ключ ServerMind. Добавьте публичный ключ в ~/.ssh/authorized_keys пользователя " + input.username + ".");
        const s = {
            id: uid("srv"),
            name: input.name,
            host: input.host,
            port: input.port,
            username: input.username,
            os: "Ubuntu 24.04.1 LTS",
            status: "online",
            lastCheckedAt: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0),
            lastSuccessAt: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0),
            uptimeSeconds: 86400 * 2,
            cpuPercent: 6,
            ramUsedMb: 710,
            ramTotalMb: 3912,
            diskUsedGb: 5.4,
            diskTotalGb: 38.7,
            fingerprint: input.fingerprint,
            services: [
                {
                    name: "ssh",
                    state: "active",
                    managed: false
                }
            ],
            source: "demo"
        };
        st.servers.push(s);
        st.audit.unshift({
            id: uid("au"),
            at: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0),
            actor: "demo@servermind.example",
            action: "server.add",
            target: s.name
        });
        emit();
        return ok({
            os: s.os ?? "—",
            server: {
                ...s
            }
        });
    }, 900);
const recheck = (id)=>gate(async ()=>{
        const st = await getState();
        const s = st.servers.find((x)=>x.id === id);
        if (!s) return fail("not_found", "Сервер не найден.");
        if (s.status === "offline") {
            s.lastCheckedAt = (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0);
            emit();
            return fail("error", "Сервер по-прежнему недоступен. Последняя успешная проверка сохранена.");
        }
        s.lastCheckedAt = (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0);
        s.lastSuccessAt = (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0);
        emit();
        return ok({
            ...s
        });
    }, 900);
const logs = (id, unit)=>gate(async ()=>{
        const s = (await getState()).servers.find((x)=>x.id === id);
        if (!s) return fail("not_found", "Сервер не найден.");
        if (s.status === "offline") return fail("error", "Сервер недоступен — логи получить нельзя.");
        return ok({
            lines: __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["DEMO_LOG_LINES"][unit] ?? __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["DEMO_LOG_LINES"].default ?? [],
            fetchedAt: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0),
            source: "demo"
        });
    }, 500);
const history = (serverId)=>gate(async ()=>[
            ...(await getState()).messages[serverId] ?? []
        ], 150);
const send = (serverId, text)=>gate(async ()=>{
        const st = await getState();
        const s = st.servers.find((x)=>x.id === serverId);
        if (!s) return fail("not_found", "Выберите сервер.");
        if (st.mode === "byok" && st.keys.length === 0) return fail("forbidden", "Не подключён ключ провайдера. Добавьте ключ в «Биллинг» или переключитесь на кредиты.");
        const bal = st.ledger.reduce((a, e)=>a + e.amount, 0);
        if (st.mode === "credits" && bal <= 0) return fail("forbidden", "Недостаточно кредитов. Обратитесь к администратору беты.");
        const list = st.messages[serverId] ??= [];
        const user = {
            id: uid("m"),
            role: "user",
            text,
            createdAt: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0)
        };
        list.push(user);
        const wantsFix = /502|ошибк|не работает|упал|недоступ|перезапуст|restart/i.test(text);
        const tools = [
            {
                id: uid("t"),
                tool: "server.facts",
                args: `server=${s.name}`,
                status: "done",
                summary: s.os ? `${s.os}, uptime ${Math.round((s.uptimeSeconds ?? 0) / 86400)} д` : "ОС не определена"
            },
            {
                id: uid("t"),
                tool: "service.status",
                args: `units=${s.services.map((x)=>x.name).join(",") || "—"}`,
                status: "done",
                summary: s.services.map((x)=>`${x.name}: ${x.state}`).join("; ") || "нет данных"
            }
        ];
        let reply;
        const failed = s.services.find((x)=>x.state === "failed");
        if (wantsFix && failed) {
            tools.push({
                id: uid("t"),
                tool: "service.logs",
                args: `unit=${failed.name} lines=200`,
                status: "done",
                summary: "найдено fatal: database pool exhausted"
            });
            const plan = await makePlan({
                id: uid("plan"),
                serverId: s.id,
                serverName: s.name,
                title: `Перезапуск сервиса ${failed.name}`,
                summary: `Сервис ${failed.name} остановился (exit 1), nginx получает отказ upstream и отвечает 502.`,
                steps: [
                    {
                        id: "s1",
                        tool: "service.restart",
                        title: `Перезапустить ${failed.name}.service`,
                        risk: "R2",
                        optional: false,
                        enabled: true,
                        params: {
                            unit: failed.name
                        },
                        expectedChange: `Служба ${failed.name} будет остановлена и запущена заново.`,
                        verify: `systemctl is-active ${failed.name}`,
                        rollback: "Откат не требуется: повторный перезапуск безопасен."
                    },
                    {
                        id: "s2",
                        tool: "http.healthcheck",
                        title: "Проверить, что сайт отвечает 200",
                        risk: "R1",
                        optional: true,
                        enabled: true,
                        params: {
                            url: "http://127.0.0.1:8080/healthz",
                            expect_status: 200
                        },
                        expectedChange: "Изменений нет — только чтение.",
                        verify: "HTTP 200",
                        rollback: "Не требуется."
                    }
                ],
                downtime: "Приложение недоступно ~5–10 секунд во время перезапуска.",
                createdAt: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0),
                expiresAt: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(15 * 60)
            });
            st.plans.push(plan);
            st.operations.unshift(makeOperationForPlan(plan, "Демо-пользователь"));
            reply = {
                id: uid("m"),
                role: "assistant",
                demo: true,
                createdAt: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(1),
                tools,
                text: `Причина 502, вероятнее всего, в сервисе ${failed.name}: он завершился с ошибкой, а nginx не может подключиться к upstream. Я ничего не менял на сервере — это только чтение.`,
                observed: [
                    `${failed.name}.service — failed (exit 1)`,
                    "В логах: «fatal: database pool exhausted, exiting»",
                    "nginx: connect() failed (111: Connection refused) while connecting to upstream"
                ],
                proposal: {
                    title: plan.title,
                    steps: plan.steps.map((x)=>x.title),
                    planId: plan.id
                }
            };
        } else {
            const cpu = s.cpuPercent == null ? "нет данных" : `${s.cpuPercent}%`;
            reply = {
                id: uid("m"),
                role: "assistant",
                demo: true,
                createdAt: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(1),
                tools,
                text: s.status === "offline" ? "Сервер сейчас недоступен: данных о нагрузке нет, последняя успешная проверка сохранена. Проверьте сеть и firewall у провайдера." : `По данным последней проверки: CPU ${cpu}, диск ${s.diskUsedGb} из ${s.diskTotalGb} ГБ. Критичных проблем в выбранных показателях не вижу. Опишите симптом (например, «сайт отвечает 502»), и я подготовлю план.`,
                observed: s.status === "offline" ? [] : [
                    `CPU ${cpu}`,
                    `RAM ${s.ramUsedMb} из ${s.ramTotalMb} МБ`,
                    `Диск ${s.diskUsedGb} из ${s.diskTotalGb} ГБ`
                ]
            };
        }
        list.push(reply);
        if (st.mode === "credits") {
            const cost = wantsFix ? 14 : 6;
            st.ledger.push({
                id: uid("led"),
                at: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(1),
                kind: "capture",
                amount: -cost,
                note: wantsFix ? "Диагностика (демо)" : "Ответ (демо)",
                model: "demo-model",
                tokensIn: 1200,
                tokensOut: 300
            });
        }
        emit();
        return ok([
            user,
            reply
        ]);
    }, 1100);
const operations = ()=>gate(async ()=>(await getState()).operations.map((o)=>({
                ...o
            })));
const operation = (id)=>gate(async ()=>{
        const o = (await getState()).operations.find((x)=>x.id === id);
        return o ? ok({
            ...o,
            events: [
                ...o.events
            ]
        }) : fail("not_found", "Операция не найдена.");
    });
const plan = (id)=>gate(async ()=>{
        const st = await getState();
        const p = st.plans.find((x)=>x.id === id);
        if (!p) return fail("not_found", "План не найден.");
        if (p.status === "waiting_approval" && Date.parse(p.expiresAt) < Date.now()) {
            p.status = "expired";
            const o = st.operations.find((x)=>x.planId === p.id);
            if (o) {
                o.status = "expired";
                o.finishedAt = (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0);
            }
        }
        return ok({
            ...p,
            steps: p.steps.map((s)=>({
                    ...s
                }))
        });
    }, 150);
const setStepEnabled = (id, stepId, enabled)=>gate(async ()=>{
        const st = await getState();
        const p = st.plans.find((x)=>x.id === id);
        if (!p) return fail("not_found", "План не найден.");
        if (p.status !== "waiting_approval") return fail("forbidden", "План уже нельзя изменить.");
        const step = p.steps.find((s)=>s.id === stepId);
        if (!step) return fail("not_found", "Шаг не найден.");
        if (!step.optional) return fail("forbidden", "Обязательный шаг нельзя отключить.");
        step.enabled = enabled;
        p.revision += 1; // любое изменение плана → новая ревизия и новый хеш → прежнее подтверждение недействительно
        p.canonicalHash = await (0, __TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$plan$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["computePlanHash"])(p);
        const o = st.operations.find((x)=>x.planId === p.id);
        if (o) {
            o.stepsTotal = p.steps.filter((s)=>s.enabled).length;
            o.risk = (0, __TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$plan$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["planRisk"])(p);
            o.events.push({
                id: uid("ev"),
                at: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0),
                level: "info",
                message: `План изменён: ревизия ${p.revision}. Предыдущее подтверждение сброшено.`
            });
        }
        emit();
        return ok({
            ...p,
            steps: p.steps.map((s)=>({
                    ...s
                }))
        });
    }, 120);
const approve = (id, sig)=>gate(async ()=>{
        const st = await getState();
        const p = st.plans.find((x)=>x.id === id);
        const o = st.operations.find((x)=>x.planId === id);
        if (!p || !o) return fail("not_found", "План не найден.");
        if (!st.executionEnabled) return fail("forbidden", "Исполнение отключено администратором (kill switch).");
        if (p.status !== "waiting_approval") return fail("forbidden", "План уже обработан.");
        if (Date.parse(p.expiresAt) < Date.now()) {
            p.status = "expired";
            o.status = "expired";
            o.finishedAt = (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0);
            emit();
            return fail("forbidden", "Срок действия плана истёк. Создайте план заново.");
        }
        if (sig.revision !== p.revision || sig.hash !== p.canonicalHash) return fail("validation", "План изменился после просмотра. Проверьте его и подтвердите снова.");
        const server = st.servers.find((s)=>s.id === p.serverId);
        if (!server || server.status !== "online") return fail("error", "Сервер недоступен — исполнение невозможно.");
        p.status = "approved";
        o.status = "running";
        o.startedAt = (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0);
        o.events.push({
            id: uid("ev"),
            at: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0),
            level: "info",
            message: `Подтверждено. Хеш ${p.canonicalHash.slice(0, 12)}…, ревизия ${p.revision}. [демо] Команды на сервере НЕ выполняются — идёт симуляция.`
        });
        st.audit.unshift({
            id: uid("au"),
            at: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0),
            actor: "demo@servermind.example",
            action: "plan.approve",
            target: o.id
        });
        runSimulation(st, o, p);
        emit();
        return ok({
            ...o
        });
    }, 400);
function runSimulation(st, o, p) {
    const steps = p.steps.filter((s)=>s.enabled);
    const list = [];
    steps.forEach((step, i)=>{
        list.push(setTimeout(()=>{
            o.events.push({
                id: uid("ev"),
                at: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0),
                level: "info",
                step: step.id,
                message: `[демо] Шаг ${i + 1}/${steps.length}: ${step.tool} — ${step.title}`
            });
            emit();
        }, 1200 + i * 2600));
        list.push(setTimeout(()=>{
            o.stepsDone = i + 1;
            o.events.push({
                id: uid("ev"),
                at: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0),
                level: "info",
                step: step.id,
                message: `[демо] Проверка: ${step.verify} — симуляция успешна`
            });
            if (i === steps.length - 1) {
                o.status = "succeeded";
                o.finishedAt = (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0);
                o.events.push({
                    id: uid("ev"),
                    at: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0),
                    level: "info",
                    message: "[демо] Операция завершена. Реальных изменений на сервере не было."
                });
                const dep = st.deployments.find((d)=>d.operationId === o.id);
                if (dep) dep.status = "succeeded";
            }
            emit();
        }, 1200 + i * 2600 + 1500));
    });
    timers.set(o.id, list);
}
const cancel = (id)=>gate(async ()=>{
        const st = await getState();
        const o = st.operations.find((x)=>x.id === id);
        if (!o) return fail("not_found", "Операция не найдена.");
        if (o.status !== "running" && o.status !== "queued" && o.status !== "waiting_approval") return fail("forbidden", "Операцию уже нельзя отменить.");
        timers.get(id)?.forEach(clearTimeout);
        o.status = "cancelled";
        o.finishedAt = (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0);
        o.events.push({
            id: uid("ev"),
            at: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0),
            level: "warn",
            message: "Операция отменена. Отмена не равнозначна откату: уже выполненные шаги не откатываются."
        });
        const p = st.plans.find((x)=>x.id === o.planId);
        if (p && p.status === "waiting_approval") p.status = "rejected";
        emit();
        return ok({
            ...o
        });
    }, 200);
const reject = (id)=>gate(async ()=>{
        const st = await getState();
        const p = st.plans.find((x)=>x.id === id);
        if (!p) return fail("not_found", "План не найден.");
        if (p.status !== "waiting_approval") return fail("forbidden", "План уже обработан.");
        p.status = "rejected";
        const o = st.operations.find((x)=>x.planId === id);
        if (o) {
            o.status = "cancelled";
            o.finishedAt = (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0);
            o.events.push({
                id: uid("ev"),
                at: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0),
                level: "info",
                message: "План отклонён владельцем. Изменений не вносилось."
            });
        }
        st.audit.unshift({
            id: uid("au"),
            at: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0),
            actor: "demo@servermind.example",
            action: "plan.reject",
            target: id
        });
        emit();
        return ok({
            ...p
        });
    }, 200);
const templates = ()=>gate(()=>__TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["TEMPLATES"], 120);
const deployments = ()=>gate(async ()=>(await getState()).deployments.map((d)=>({
                ...d
            })));
const preflight = (input)=>gate(async ()=>{
        const st = await getState();
        const s = st.servers.find((x)=>x.id === input.serverId);
        if (!s) return fail("not_found", "Сервер не найден.");
        const diskPct = s.diskUsedGb != null && s.diskTotalGb ? s.diskUsedGb / s.diskTotalGb * 100 : null;
        const checks = [
            {
                id: "online",
                label: "Сервер доступен",
                status: s.status === "online" ? "pass" : "fail",
                detail: s.status === "online" ? "Последняя проверка успешна." : "Сервер офлайн — деплой невозможен.",
                blocking: true
            },
            {
                id: "disk",
                label: "Свободное место на диске",
                status: diskPct == null ? "warn" : diskPct >= 90 ? "fail" : diskPct >= 75 ? "warn" : "pass",
                detail: diskPct == null ? "Нет данных." : `Занято ${Math.round(diskPct)}%. ${diskPct >= 90 ? "Ресурсоёмкие операции заблокированы при 90%." : diskPct >= 75 ? "Предупреждение: больше 75%." : "Достаточно."}`,
                blocking: diskPct != null && diskPct >= 90
            },
            {
                id: "docker",
                label: "Docker установлен",
                status: s.services.some((x)=>x.name === "docker" && x.state === "active") ? "pass" : "warn",
                detail: s.services.some((x)=>x.name === "docker" && x.state === "active") ? "Служба docker активна." : "Docker не запущен — в план будет добавлена установка (R3, требует подтверждения).",
                blocking: false
            },
            {
                id: "dns",
                label: "DNS указывает на сервер",
                status: input.domain ? input.domain.endsWith(".servermind.example") ? "warn" : "pass" : "warn",
                detail: input.domain ? input.domain.endsWith(".servermind.example") ? "[демо] Домен-заглушка не разрешается. HTTPS не будет настроен." : "[демо] A-запись совпала с IP сервера." : "Домен не указан — приложение будет доступно только на localhost сервера.",
                blocking: false
            }
        ];
        return ok(checks);
    }, 800);
const createDeployPlan = (input)=>gate(async ()=>{
        const st = await getState();
        const s = st.servers.find((x)=>x.id === input.serverId);
        const tpl = __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["TEMPLATES"].find((t)=>t.id === input.templateId);
        if (!s || !tpl || !tpl.available) return fail("validation", "Выберите доступный шаблон и сервер.");
        const needDocker = !s.services.some((x)=>x.name === "docker" && x.state === "active");
        const steps = [];
        if (needDocker) steps.push(waitingPlanSteps()[0]);
        steps.push({
            id: "s2",
            tool: "app.deploy_compose",
            title: `Запустить шаблон «${tpl.name}»`,
            risk: "R3",
            optional: false,
            enabled: true,
            params: {
                template: tpl.id,
                port: tpl.port,
                env_keys: input.envKeys.join(",") || "(нет)",
                read_only_rootfs: true,
                privileged: false
            },
            expectedChange: "Создаётся проект Compose из проверенного шаблона. Значения переменных окружения в план и журнал не попадают.",
            verify: "docker compose ps — running (healthy)",
            rollback: "docker compose down — данные тома сохраняются."
        });
        steps.push({
            ...waitingPlanSteps()[2],
            id: "s3"
        });
        const pl = await makePlan({
            id: uid("plan"),
            serverId: s.id,
            serverName: s.name,
            title: `Деплой «${tpl.name}»`,
            summary: `Развернуть шаблон на ${s.name}${input.domain ? `, домен ${input.domain}` : ""}.`,
            steps,
            downtime: "Новое приложение; существующие службы не затрагиваются.",
            createdAt: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0),
            expiresAt: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(15 * 60)
        });
        st.plans.push(pl);
        const op = makeOperationForPlan(pl, "Демо-пользователь");
        st.operations.unshift(op);
        st.deployments.unshift({
            id: uid("dep"),
            serverId: s.id,
            serverName: s.name,
            template: tpl.name,
            domain: input.domain || null,
            status: "waiting_approval",
            createdAt: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0),
            operationId: op.id,
            source: "demo"
        });
        emit();
        return ok({
            ...pl
        });
    }, 600);
const history_ = (serverId, hours)=>gate(async ()=>{
        const st = await getState();
        const s = st.servers.find((x)=>x.id === serverId);
        if (!s) return fail("not_found", "Сервер не найден.");
        const base = __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["DEMO_HISTORY_BASE"][serverId];
        if (!base || scenario() === "nohistory") return ok({
            samples: [],
            intervalSec: 900,
            source: "demo"
        });
        const all = (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["demoSeries"])(base.seed, 96 * 7, base);
        return ok({
            samples: all.slice(-Math.min(all.length, hours * 4)),
            intervalSec: 900,
            source: "demo"
        });
    }, 350);
const balance = ()=>gate(async ()=>{
        const st = await getState();
        return {
            available: st.ledger.reduce((a, e)=>a + e.amount, 0),
            reserved: 0,
            dailyCap: 500,
            monthlyCap: 5000
        };
    }, 150);
const ledger = ()=>gate(async ()=>[
            ...(await getState()).ledger
        ].reverse());
const keys = ()=>gate(async ()=>[
            ...(await getState()).keys
        ]);
const addKey = (input)=>gate(async ()=>{
        const st = await getState();
        if (input.key.trim().length < 12) return fail("validation", "Ключ слишком короткий.");
        // значение ключа не сохраняется нигде — только маска
        const k = {
            id: uid("key"),
            provider: input.provider,
            masked: (0, __TURBOPACK__imported__module__$5b$project$5d2f$lib$2f$validation$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["maskKey"])(input.key),
            createdAt: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0),
            status: input.skipValidation ? "unchecked" : "valid"
        };
        st.keys.push(k);
        emit();
        return ok(k);
    }, 800);
const deleteKey = (id)=>gate(async ()=>{
        const st = await getState();
        st.keys = st.keys.filter((k)=>k.id !== id);
        emit();
        return {
            ok: true
        };
    }, 200);
const getMode = ()=>gate(async ()=>({
            mode: (await getState()).mode
        }), 80);
const setMode = (mode)=>gate(async ()=>{
        (await getState()).mode = mode;
        emit();
        return {
            mode
        };
    }, 120);
const sessions = ()=>gate(async ()=>[
            ...(await getState()).sessions
        ]);
const revokeSession = (id)=>gate(async ()=>{
        const st = await getState();
        const s = st.sessions.find((x)=>x.id === id);
        if (s?.current) return fail("forbidden", "Текущую сессию завершите через «Выйти».");
        st.sessions = st.sessions.filter((x)=>x.id !== id);
        emit();
        return ok({
            ok: true
        });
    }, 200);
const policy = ()=>gate(async ()=>({
            ...(await getState()).policy
        }), 100);
const setPolicy = (p)=>gate(async ()=>{
        const st = await getState();
        st.policy = {
            ...st.policy,
            ...p,
            requireApprovalR2: true,
            requireApprovalR3: true
        }; // обязательные подтверждения отключить нельзя
        emit();
        return {
            ...st.policy
        };
    }, 150);
const deleteSecrets = (serverId)=>gate(async ()=>{
        const st = await getState();
        const s = st.servers.find((x)=>x.id === serverId);
        if (!s) return fail("not_found", "Сервер не найден.");
        st.servers = st.servers.filter((x)=>x.id !== serverId);
        st.audit.unshift({
            id: uid("au"),
            at: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0),
            actor: "demo@servermind.example",
            action: "server.secrets.delete",
            target: s.name
        });
        emit();
        return ok({
            ok: true
        });
    }, 400);
const invites = ()=>gate(async ()=>[
            ...(await getState()).invites
        ]);
const createInvite = ()=>gate(async ()=>{
        const st = await getState();
        const part = ()=>Math.random().toString(36).slice(2, 6).toUpperCase();
        const inv = {
            code: `BETA-${part()}-${part()}`,
            createdAt: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0),
            expiresAt: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(86400 * 7),
            usedBy: null
        };
        st.invites.unshift(inv);
        st.audit.unshift({
            id: uid("au"),
            at: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0),
            actor: "owner",
            action: "invite.create",
            target: inv.code
        });
        emit();
        return inv;
    }, 300);
const audit = ()=>gate(async ()=>[
            ...(await getState()).audit
        ]);
const issueCredits = (input)=>gate(async ()=>{
        const st = await getState();
        if (!Number.isInteger(input.amount) || input.amount <= 0 || input.amount > 10000) return fail("validation", "Сумма — целое от 1 до 10 000.");
        if (input.reason.trim().length < 5) return fail("validation", "Укажите причину (для аудита).");
        st.ledger.push({
            id: uid("led"),
            at: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0),
            kind: "credit",
            amount: input.amount,
            note: `Тестовые кредиты (admin): ${input.reason.trim()}`
        });
        st.audit.unshift({
            id: uid("au"),
            at: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0),
            actor: "owner",
            action: "credits.issue",
            target: `${input.email} · ${input.amount}`
        });
        emit();
        return ok({
            ok: true
        });
    }, 400);
const flags = ()=>gate(async ()=>(await getState()).flags.map((f)=>({
                ...f
            })));
const setFlag = (key, enabled)=>gate(async ()=>{
        const st = await getState();
        const f = st.flags.find((x)=>x.key === key);
        if (!f) return fail("not_found", "Флаг не найден.");
        f.enabled = enabled;
        st.audit.unshift({
            id: uid("au"),
            at: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0),
            actor: "owner",
            action: "flag.set",
            target: `${key}=${enabled}`
        });
        emit();
        return ok(st.flags.map((x)=>({
                ...x
            })));
    }, 150);
const killSwitch = ()=>gate(async ()=>({
            executionEnabled: (await getState()).executionEnabled
        }), 80);
const setKillSwitch = (executionEnabled)=>gate(async ()=>{
        const st = await getState();
        st.executionEnabled = executionEnabled;
        st.audit.unshift({
            id: uid("au"),
            at: (0, __TURBOPACK__imported__module__$5b$project$5d2f$fixtures$2f$dev$2f$data$2e$ts__$5b$app$2d$ssr$5d$__$28$ecmascript$29$__["iso"])(0),
            actor: "owner",
            action: "kill_switch",
            target: executionEnabled ? "execution enabled" : "execution DISABLED"
        });
        emit();
        return {
            executionEnabled
        };
    }, 200);
}),
"[project]/lib/plan.ts [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "canonicalize",
    ()=>canonicalize,
    "computePlanHash",
    ()=>computePlanHash,
    "maxRisk",
    ()=>maxRisk,
    "planHashPayload",
    ()=>planHashPayload,
    "planRisk",
    ()=>planRisk,
    "sha256Fallback",
    ()=>sha256Fallback,
    "sha256Hex",
    ()=>sha256Hex,
    "shortHash",
    ()=>shortHash
]);
const RISK_ORDER = [
    "R0",
    "R1",
    "R2",
    "R3",
    "R4",
    "R5"
];
function maxRisk(risks) {
    return risks.reduce((a, b)=>RISK_ORDER.indexOf(b) > RISK_ORDER.indexOf(a) ? b : a, "R0");
}
function planRisk(plan) {
    return maxRisk(plan.steps.filter((s)=>s.enabled).map((s)=>s.risk));
}
function canonicalize(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
    const obj = value;
    return `{${Object.keys(obj).sort().map((k)=>`${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}
function planHashPayload(plan) {
    return {
        plan_id: plan.id,
        server_id: plan.serverId,
        revision: plan.revision,
        expires_at: plan.expiresAt,
        steps: plan.steps.filter((s)=>s.enabled).map((s)=>({
                tool: s.tool,
                params: s.params,
                risk: s.risk
            }))
    };
}
async function computePlanHash(plan) {
    return sha256Hex(canonicalize(planHashPayload(plan)));
}
async function sha256Hex(text) {
    const data = new TextEncoder().encode(text);
    const subtle = typeof crypto !== "undefined" ? crypto.subtle : undefined;
    if (subtle) {
        const buf = await subtle.digest("SHA-256", data);
        return [
            ...new Uint8Array(buf)
        ].map((b)=>b.toString(16).padStart(2, "0")).join("");
    }
    return sha256Fallback(data); // небезопасный контекст (http по LAN): crypto.subtle недоступен
}
const K = new Uint32Array([
    0x428a2f98,
    0x71374491,
    0xb5c0fbcf,
    0xe9b5dba5,
    0x3956c25b,
    0x59f111f1,
    0x923f82a4,
    0xab1c5ed5,
    0xd807aa98,
    0x12835b01,
    0x243185be,
    0x550c7dc3,
    0x72be5d74,
    0x80deb1fe,
    0x9bdc06a7,
    0xc19bf174,
    0xe49b69c1,
    0xefbe4786,
    0x0fc19dc6,
    0x240ca1cc,
    0x2de92c6f,
    0x4a7484aa,
    0x5cb0a9dc,
    0x76f988da,
    0x983e5152,
    0xa831c66d,
    0xb00327c8,
    0xbf597fc7,
    0xc6e00bf3,
    0xd5a79147,
    0x06ca6351,
    0x14292967,
    0x27b70a85,
    0x2e1b2138,
    0x4d2c6dfc,
    0x53380d13,
    0x650a7354,
    0x766a0abb,
    0x81c2c92e,
    0x92722c85,
    0xa2bfe8a1,
    0xa81a664b,
    0xc24b8b70,
    0xc76c51a3,
    0xd192e819,
    0xd6990624,
    0xf40e3585,
    0x106aa070,
    0x19a4c116,
    0x1e376c08,
    0x2748774c,
    0x34b0bcb5,
    0x391c0cb3,
    0x4ed8aa4a,
    0x5b9cca4f,
    0x682e6ff3,
    0x748f82ee,
    0x78a5636f,
    0x84c87814,
    0x8cc70208,
    0x90befffa,
    0xa4506ceb,
    0xbef9a3f7,
    0xc67178f2
]);
function sha256Fallback(data) {
    const h = new Uint32Array([
        0x6a09e667,
        0xbb67ae85,
        0x3c6ef372,
        0xa54ff53a,
        0x510e527f,
        0x9b05688c,
        0x1f83d9ab,
        0x5be0cd19
    ]);
    const len = data.length;
    const padded = new Uint8Array(len + 9 + 63 >> 6 << 6);
    padded.set(data);
    padded[len] = 0x80;
    const dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, Math.floor(len * 8 / 0x100000000));
    dv.setUint32(padded.length - 4, len * 8 >>> 0);
    const w = new Uint32Array(64);
    const rotr = (x, n)=>x >>> n | x << 32 - n;
    for(let off = 0; off < padded.length; off += 64){
        for(let i = 0; i < 16; i++)w[i] = dv.getUint32(off + i * 4);
        for(let i = 16; i < 64; i++){
            const a = w[i - 15];
            const b = w[i - 2];
            const s0 = rotr(a, 7) ^ rotr(a, 18) ^ a >>> 3;
            const s1 = rotr(b, 17) ^ rotr(b, 19) ^ b >>> 10;
            w[i] = w[i - 16] + s0 + w[i - 7] + s1 >>> 0;
        }
        let [a, b, c, d, e, f, g, hh] = h;
        for(let i = 0; i < 64; i++){
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = e & f ^ ~e & g;
            const t1 = hh + S1 + ch + K[i] + w[i] >>> 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = a & b ^ a & c ^ b & c;
            const t2 = S0 + maj >>> 0;
            hh = g;
            g = f;
            f = e;
            e = d + t1 >>> 0;
            d = c;
            c = b;
            b = a;
            a = t1 + t2 >>> 0;
        }
        h[0] = h[0] + a >>> 0;
        h[1] = h[1] + b >>> 0;
        h[2] = h[2] + c >>> 0;
        h[3] = h[3] + d >>> 0;
        h[4] = h[4] + e >>> 0;
        h[5] = h[5] + f >>> 0;
        h[6] = h[6] + g >>> 0;
        h[7] = h[7] + hh >>> 0;
    }
    return [
        ...h
    ].map((x)=>x.toString(16).padStart(8, "0")).join("");
}
function shortHash(hash) {
    return hash ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : "—";
}
}),
"[project]/lib/validation.ts [app-ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

__turbopack_context__.s([
    "checkDomain",
    ()=>checkDomain,
    "checkEmail",
    ()=>checkEmail,
    "checkHost",
    ()=>checkHost,
    "checkPort",
    ()=>checkPort,
    "checkUsername",
    ()=>checkUsername,
    "maskKey",
    ()=>maskKey
]);
/** UX-проверки на клиенте. Источник истины — сервер (Фаза 2: SSRF-политика, DNS re-resolve + pinning). */ const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
function checkHost(raw) {
    const host = raw.trim().toLowerCase();
    if (!host) return {
        ok: false,
        reason: "Укажите IP-адрес или доменное имя."
    };
    const v4 = IPV4_RE.exec(host);
    if (v4) {
        const o = v4.slice(1).map(Number);
        if (o.some((n)=>n > 255)) return {
            ok: false,
            reason: "Некорректный IPv4-адрес."
        };
        const [a, b] = o;
        if (a === 10 || a === 127 || a === 0 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 169 && b === 254 || a === 100 && b >= 64 && b <= 127) {
            return {
                ok: false,
                reason: "Приватные, loopback и link-local адреса запрещены политикой безопасности."
            };
        }
        return {
            ok: true
        };
    }
    if (host.includes(":")) return {
        ok: false,
        reason: "IPv6 в MVP не поддерживается. Используйте IPv4 или доменное имя."
    };
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
        return {
            ok: false,
            reason: "Локальные имена запрещены политикой безопасности."
        };
    }
    if (!HOSTNAME_RE.test(host)) return {
        ok: false,
        reason: "Некорректное доменное имя."
    };
    return {
        ok: true
    };
}
function checkPort(raw) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return {
        ok: false,
        reason: "Порт — число от 1 до 65535."
    };
    return {
        ok: true,
        port: n
    };
}
function checkUsername(raw) {
    const u = raw.trim();
    if (u === "root") return {
        ok: false,
        reason: "Вход под root запрещён. Используйте отдельного пользователя servermind."
    };
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(u)) return {
        ok: false,
        reason: "Имя пользователя: строчные латинские буквы, цифры, _ и -."
    };
    return {
        ok: true
    };
}
function checkEmail(raw) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw.trim());
}
function checkDomain(raw) {
    return HOSTNAME_RE.test(raw.trim());
}
function maskKey(key) {
    const t = key.trim();
    return t.length <= 8 ? "••••" : `${t.slice(0, 3)}••••${t.slice(-4)}`;
}
}),
];

//# sourceMappingURL=_0ih1wmm1qf81g._.js.map