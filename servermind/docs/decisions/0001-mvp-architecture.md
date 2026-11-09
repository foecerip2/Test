# ADR 0001 — Архитектура MVP ServerMind

Статус: принято (Фаза 0) · Дата: 2026-11-09

## Контекст

Один VPS (1–2 vCPU, 4 ГБ RAM, 40 ГБ SSD, Ubuntu 24.04), владелец + 3–10 тестировщиков. AI — недоверенный планировщик. Источник требований: `SERVERMIND_CLAUDE_MASTER_PLAN_V2.md` (далее MD).

## Решения

| # | Решение | Обоснование / альтернатива |
|---|---|---|
| 1 | Модульный монолит: `web` (Next.js standalone), `api` (FastAPI), `worker` (тот же кодбейс, отдельный процесс), `db` (PostgreSQL 16), `caddy` | MD §0.1. Kubernetes/микросервисы не помещаются в бюджет RAM |
| 2 | Очередь — таблица `jobs` в PostgreSQL, `FOR UPDATE SKIP LOCKED`, lease+heartbeat, idempotency key | Без Redis/Celery (экономия 100–300 МБ). Пересмотреть при росте нагрузки |
| 3 | `MAX_CONCURRENT_EXECUTIONS=1`, один активный mutating job на сервер (partial unique index) | MD §4 |
| 4 | Сборка web — только в CI (Docker image, `output: 'standalone'`) | `next build` на 4 ГБ VPS рискует OOM |
| 5 | AI — только официальные API (OpenAI/Anthropic/DeepSeek), BYOK + Credits, без LiteLLM и локальных LLM | MD §0, §5 |
| 6 | Мониторинг — периодический SSH-опрос в worker, `server_metric_samples` с TTL; без Prometheus/Grafana | MD §0.1 |
| 7 | UI: Next.js + Tailwind v4 + shadcn-подход (Radix primitives, CVA) + lucide + Motion (`motion/react`). GSAP/Rive/Lottie/Aceternity/Magic UI **не подключены** | MD §16.5, см. `docs/ADR-motion.md` |
| 8 | Шрифты self-hosted: `@fontsource-variable/inter` (кириллица), `jetbrains-mono`; без запросов к Google Fonts | Приватность, офлайн-сборка, OFL |
| 9 | Графики — собственный SVG sparkline, без Recharts | Размер бандла |
| 10 | Моки изолированы в `apps/web/fixtures/dev`, включаются только `NEXT_PUBLIC_DEV_FIXTURES=1`, при этом всегда виден баннер «Демо-данные». Без флага данные берутся из API; если API недоступен — честный error state | MD §17 |
| 11 | Размещение: подкаталог `servermind/` внутри текущего репозитория (отдельный репозиторий из этой сессии создать нельзя). Переносится `git subtree split` | Не затрагивает `vaylo/` и `docs/` соседнего проекта |
| 12 | Домен не задан: `servermind.example`, всё через env | MD §0 |

## Ресурсная оценка (расчётная, НЕ измерена)

Бюджет RAM из MD §0.1: ОС 500–800, Postgres 250–500, API 200–450, web 200–450, worker 250–600, Caddy 30–100 МБ → 1.4–2.9 ГБ при цели idle ≤ 2.5 ГБ. Планируемые cgroup-лимиты: postgres 640M, api 450M, web 400M, worker 500M, caddy 96M ≈ 2.1 ГБ; запас ≈ 1.9 ГБ на ОС и page cache.

Диск 40 ГБ: ОС+Docker ≈ 8–10 ГБ, образы ≈ 1.5 ГБ, Postgres ≤ 2 ГБ (TTL метрик 14 дней, логов job 30 дней), Docker logs `max-size=10m, max-file=3`. Цель свободных ≥ 8 ГБ; 75% — предупреждение, 90% — блок ресурсоёмких задач.

Фактические замеры — Фаза 5 (`docs/operations/performance-report.md`). Песочница сессии: Ubuntu 24.04, 4 vCPU / 16 ГБ, Docker-демона нет — целевые лимиты воспроизвести нельзя.

## Последствия

- Worker на том же VPS — не полная изоляция (MD §3); для публичного multi-tenant нужен отдельный execution node.
- Привилегированные мутации на целевых серверах остаются *manual bootstrap*, пока не пройдёт security review (Фаза 4).
