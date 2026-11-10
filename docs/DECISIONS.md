# DECISIONS (ADR)

Формат: контекст → решение → последствия. Статус `proposed` = ждёт подтверждения владельца.

## ADR-001 · UI без Tailwind/shadcn · proposed
Контекст: ТЗ §4 указывает Tailwind + shadcn/ui; CLAUDE_IMPLEMENTATION и задача требуют не generic-шаблон.
Решение: CSS-переменные из DESIGN_SYSTEM + собственные компоненты (CSS Modules), headless-примитивы только для a11y (диалог/меню) при необходимости.
Последствия: больше ручной работы, точнее совпадение с прототипом, меньше зависимостей и бандл.

## ADR-002 · Маршруты и API · proposed
8 маршрутов `/overview /discovery /companies /approvals /inbox /pipeline /analytics /settings` + `/login`, `/companies/[id]`. API `/api/v1` по ТЗ §7 + `/analytics/summary`. Имена таблиц по ТЗ §6.

## ADR-003 · Единый бэкенд-образ · proposed
`apps/api` содержит пакет `leadhunter`; `workers/*` импортируют его; один Docker-образ запускается как `api` / `worker` / `beat`. Экономит диск и время CI на 40 ГБ.

## ADR-004 · Caddy вместо Nginx · proposed
Авто-HTTPS (Let's Encrypt), простая конфигурация, малый расход RAM. ТЗ §3 допускает оба.

## ADR-005 · Celery + Redis · accepted (ТЗ)
concurrency=2, recycle по памяти, состояние в PostgreSQL. Пересмотр только по результатам замера.

## ADR-006 · Одна origin, cookie-сессии · proposed
Caddy проксирует `/api`. Сессия `HttpOnly; Secure; SameSite=Lax`, CSRF double-submit, короткий TTL, rate limit, Argon2id, TOTP (опционально, Фаза 2).

## ADR-007 · Деплой с ручным утверждением · proposed
GitHub Environment `production` + required reviewer; образы по digest; отдельный `deploy`-пользователь без root; pin сторонних actions по SHA; backup перед миграциями; только backward-compatible миграции; авто-откат при провале smoke-теста.

## ADR-008 · Статусы · proposed
Источник истины — машины состояний ТЗ §8; статусы прототипа — вычисляемое отображение.

## ADR-009 · Типографика и контраст · proposed
Тело 14 px, мета ≥12 px, touch ≥44 px. Вторичные цвета затемняются до AA (проверка в CI). Шрифты self-host (`next/font`): Manrope + Inter (кириллица). Без запросов к Google в рантайме.

## ADR-010 · Безопасность отправки · accepted (ТЗ, CLAUDE)
`send_permission` deny-by-default; согласие адресата ≠ одобрение текста; сервер — единственный арбитр `can_send`; transactional outbox; `unknown_delivery` вместо слепого повтора; `EMERGENCY_STOP_SEND`; отказ → permanent suppression.

## ADR-011 · AI · accepted (ТЗ, CLAUDE)
Режимы: без AI (по умолчанию) → официальный API-ключ → ручной экспорт/импорт. Никакой автоматизации подписок ChatGPT/Claude, cookies и web-login. Контент сайтов/ответов — недоверенный (prompt injection).

## ADR-012 · Бэкапы · proposed
`pg_dump` → `age`-шифрование → VPS-2 → (временно) VPS-3; 7 дневных + 4 недельных; еженедельная проверка восстановления.
