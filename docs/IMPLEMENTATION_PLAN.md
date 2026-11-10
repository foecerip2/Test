# LeadHunter AI MVP 1.0 — Фаза 0: аудит и план реализации

Статус: **черновик на согласование**. Код не написан, на VPS ничего не запускалось и не устанавливалось.
Источники: `docs/design-reference/` (ТЗ, CLAUDE_IMPLEMENTATION, DESIGN_SYSTEM, прототип `index.html` + `assets/`).
Ограничение этой среды: нет доступа к вашим VPS, домену и DNS, поэтому проверка серверов (раздел 8) выполняется вами по read-only командам.

---

## 1. Что именно строим

Приватный одно-пользовательский кабинет: кампании по регионам РФ → компании + доказательства → скоринг → черновик (шаблон или AI) → ручное согласование текста → **отдельная** проверка права отправки → отправка по разрешённому каналу либо задача ручного контакта → ответы → классификация → CRM-стадия. Восемь разделов: Обзор, Поиск компаний, База компаний, Согласование, Диалоги, Воронка, Аналитика, Настройки (+ вход и карточка компании).

Инварианты (проверяются тестами, не «пожеланиями»):
1. `send` разрешён только при серверной проверке: согласие `verified` + нет suppression + канал официально поддерживает отправку + текст одобрен + хэш одобренного текста = хэш отправляемого + глобальный `EMERGENCY_STOP_SEND` выключен. Иначе 403/409, попытки нет.
2. Отправка по умолчанию выключена. Реальных исходящих до моего письменного подтверждения тестового сценария нет.
3. Отказ/отписка → suppression навсегда, без ретраев.
4. Все числа в UI — из БД. Демо-данные только с меткой «Демо» и только при явном флаге.
5. Без AI весь критический путь работает.

---

## 2. Аудит документации: противоречия и решения

Предлагаемое решение для каждого пункта — в `DECISIONS.md` (ADR). Пункты, помеченные **?**, требуют вашего ответа.

| # | Противоречие / пробел | Где | Предлагаемое решение |
|---|---|---|---|
| 1 | ТЗ требует Tailwind + shadcn/ui; CLAUDE_IMPLEMENTATION и ваш запрос — «не шаблон», «не generic shadcn» | ТЗ §4 vs CLAUDE §4, §13 | CSS-переменные из дизайн-системы + собственные компоненты (CSS Modules). Без Tailwind/shadcn. **?** |
| 2 | Маршруты: ТЗ — `/dashboard /campaigns /tasks`; CLAUDE — 8 маршрутов `/overview …/settings` | ТЗ §12 vs CLAUDE §9 | 8 маршрутов из CLAUDE + `/login` + `/companies/[id]`. Кампании живут в «Поиске», задачи — в «Воронке»/«Диалогах». |
| 3 | API: `/api/…` vs `/api/v1/…`; `POST /messages/{id}/send` vs `/outbox/preview`+`/outbox/send`; разный набор ресурсов | CLAUDE §7 vs ТЗ §7 | `/api/v1`, за основу ТЗ (надмножество) + `/analytics/summary` из CLAUDE. Отдельного `/messages/send` нет. |
| 4 | Имена таблиц: `outbound_messages`/`outbox`, `tasks`/`crm_tasks`, `jobs`/`discovery_jobs` | CLAUDE §6 vs ТЗ §6 | Имена и поля из ТЗ §6 (подробнее, с индексами). `jobs` = обобщённая запись жизненного цикла Celery-задач (ТЗ §4). |
| 5 | Статусы: прототип/DESIGN (`new→analyzed→draft_ready→…→replied`, `blocked/refused/failed/manual_only`) vs машины состояний ТЗ §8 | DESIGN §UX4 vs ТЗ §8 | Источник истины — машины состояний ТЗ. Отображаемый статус компании **вычисляется** (view-model) из company+draft+outbox+conversation. |
| 6 | Reverse proxy: «Nginx» vs «Caddy или Nginx» | CLAUDE §4 vs ТЗ §3 | Caddy (автоматический HTTPS, меньше ops, малый RAM). **?** |
| 7 | Деплой: «auto по push в main» vs «staging/ручное утверждение» | ТЗ §13 vs CLAUDE §11 | GitHub Environment `production` с обязательным утверждением владельцем (одна кнопка), затем автоматический деплой по digest с healthcheck и откатом. Отдельного staging-сервера на 2 VPS нет — staging = compose-проект на VPS-1 за WireGuard/basic-auth. **?** |
| 8 | Очередь: Celery+Redis (ТЗ) vs «возможно более лёгкая очередь при ограничениях VPS» | ТЗ §4 vs CLAUDE §4 | Celery, concurrency=2, `--max-memory-per-child`. Заменяем только если замер покажет нехватку RAM. |
| 9 | Размеры текста: прототип 9–12 px, `html{font-size:14px}`; DESIGN §Шрифты — в production ≥13–14 px; hit-target ≥44 px | styles.css vs DESIGN | Production: body 14, мета ≥12, кнопки/поля 44 px на мобильном. Осознанное отклонение от прототипа, плотность компенсируется сеткой. |
| 10 | Контраст прототипа (расчётно, мои оценки): `--muted #798681` на белом ≈3.8:1, `#a0aba5` ≈2.4:1, amber-текст ≈3.3–3.6:1 — ниже AA 4.5:1 для мелкого текста | styles.css vs DESIGN «WCAG AA» | Затемняем вторичный текст и текст статус-тегов до ≥4.5:1, сохраняя палитру. Пары проверяются скриптом в CI. |
| 11 | Шрифты: DM Sans не содержит кириллицу; прототип грузит Google Fonts через `@import` (внешний запрос, приватность, офлайн) | DESIGN §Шрифты | Self-host через `next/font` (OFL): Manrope (заголовки, есть кириллица) + для текста шрифт с кириллицей (рекомендую Inter). Никаких запросов к Google в рантайме. **?** |
| 12 | Фейк в прототипе: «Все системы в порядке», «Проверено 48 из 100», счётчики 48/7/3 в навигации, `Light`-тег, кнопка уведомлений, workspace-switch, «···» у профиля, пустая колонка «Пилот», кнопки-тосты в Настройках | app.js / index.html | Каждый элемент: либо реальная функция, либо удаляется, либо `disabled` + причина. Список — в TASKS.md. Декоративные кольца у `.work-card` убираем. |
| 13 | Пробелы дизайна: нет `/login`, карточки компании, мастера импорта CSV/XLSX (dry-run), создания кампании по регионам, записи согласия и доказательства, suppression, AI «export/import task», аудита, бэкапов, расходов AI, kill-switch, `ConfirmDialog` | прототип vs ТЗ §12 | Проектирую в языке прототипа (те же токены/компоненты). Новые экраны показываю на скриншотах в Фазе 1 до подключения API. |
| 14 | Скоринг: ТЗ задаёт веса (25/20/15/15/15/10) и порог 75; прототип показывает «от 80» | ТЗ §9 vs app.js | Порог по умолчанию 75 (настраиваемый). |
| 15 | PD/152-ФЗ: физлицо-оператор; серверы могут быть не в РФ; email сотрудников/ИП — персональные данные | ТЗ §0 | До реальных контактов: подтвердить место VPS (локализация), основание и уведомление РКН. Контакты шифруются, TTL по лицензии источника. Инженерная осторожность, не юридическая консультация — нужен ваш подтверждённый ответ (раздел 9). |
| 16 | Риск расхождения кода `workers/` и `apps/api` | ТЗ §5 | Один Python-пакет `leadhunter` в `apps/api`; `workers/*` — Celery-задачи, импортирующие его. Один образ запускается как `api` или `worker`. |
| 17 | Бэкапы «off-host» при двух VPS и бюджете 0 ₽ | ТЗ §14 | Шифрованный (`age`) дамп VPS-1 → VPS-2 → временно VPS-3 (ТЗ §3 разрешает), без смешивания БД. Внешнее хранилище — только с вашего согласия по цене. |
| 18 | Прототип без скриншотов (`previews/README.md`) | пакет | Базовые скриншоты прототипа снимаю сам в Фазе 1 (Playwright) на 360/390/768/1024/1440 — эталон для сравнения. |

Уточнения: «вся Россия» = итеративные задания по городам, не обещание полной базы; отсутствие онлайн-записи = «не обнаружено»; для физлица MAX Business недоступен — MAX/VK/Telegram только `disabled`-адаптеры.

---

## 3. Архитектура

```
 Телефон / ПК ──HTTPS──▶  VPS-1 «Control»                         VPS-2 «Worker»
                          ┌────────────────────────────┐          ┌──────────────────────┐
                          │ Caddy :443 (TLS, HSTS)     │          │ celery worker (2)    │
                          │  ├─ /      → web (Next.js)  │          │  discover/enrich/    │
                          │  └─ /api   → api (FastAPI)  │          │  score/draft/sync/   │
                          │ postgres 16  (wg0 only)     │◀──WG───▶│  classify/send       │
                          │ redis 7      (wg0 only)     │ 10.8.0/24│ egress: 80/443 + SMTP│
                          │ celery beat, backup, health │          └──────────────────────┘
                          └────────────────────────────┘
                                         VPS-3: AutoFlow — резерв, LeadHunter не размещаем
```

- **Один origin**: Caddy проксирует `/api` на FastAPI → cookie-сессия `HttpOnly; Secure; SameSite=Lax` + CSRF (double-submit) без CORS.
- **Postgres и Redis** слушают только WireGuard и docker-сеть; наружу не публикуются, `ufw` default-deny.
- **Worker** без root, без docker.sock, egress-firewall (80/443 и разрешённый SMTP/IMAP), SSRF-guard в коде + сетевой запрет RFC1918/metadata.
- **Состояние задач** — в PostgreSQL (`jobs`), Redis только брокер; рестарт VPS-2 не теряет задания, outbox — transactional.
- **AI** — `AIProvider`: `DisabledProvider` (по умолчанию) → `OpenAICompatibleProvider` (официальный API-ключ, бюджет ₽/день, schema-validation, evidence_ids) → ручной экспорт/импорт AI-задачи. «Вход через подписку» показывается как недоступный.
- **Каналы**: `EmailChannel` (SMTP/IMAP, outbound выключен по умолчанию), `Max/VK/TelegramChannel` = `disabled` с feature-flag.

### Бюджет памяти (стартовые оценки, замер в Фазе 6)

| VPS | Компонент | Лимит |
|---|---|---|
| 1 (4 ГБ) | PostgreSQL (shared_buffers 256 МБ) | 1 ГБ |
| | FastAPI (2 workers) | 512 МБ |
| | Next.js standalone | 384 МБ |
| | Redis | 128 МБ |
| | Caddy + beat + health/backup | 192 МБ |
| | ОС + запас | ~1.8 ГБ |
| 2 (4 ГБ) | Celery (concurrency 2, recycle) | 1.2 ГБ |
| | агент мониторинга | 64 МБ |
| | ОС + запас | ~2.7 ГБ |

Диск 40 ГБ: образы ≈4 ГБ, Postgres ≈2–5 ГБ на MVP, резерв ≥8 ГБ (требование ТЗ), ротация логов 7 дней, бэкапы 7 дневных + 4 недельных.
Мониторинг без Prometheus/Grafana на старте (экономия RAM): JSON-логи + `/health/live|ready` + внешний бесплатный пинг/почтовые алерты + cron-проверки диска/бэкапа/heartbeat. Метрики в Prometheus-формате отдаём, чтобы подключить позже.

---

## 4. Структура репозитория (создаётся по фазам)

```
.
├── apps/
│   ├── web/                         # Next.js App Router, TS strict
│   │   ├── src/app/(auth)/login/
│   │   ├── src/app/(app)/{overview,discovery,companies,companies/[id],approvals,inbox,pipeline,analytics,settings}/
│   │   ├── src/components/          # AppShell, Sidebar, Topbar, PageHeader, MetricCard, StatusTag, ScoreBadge,
│   │   │                            # DataTable, CompanyDetail, EvidenceList, MessageEditor, ApprovalGate,
│   │   │                            # ConversationList/Thread, KanbanColumn, ActivityFeed, ConnectionCard,
│   │   │                            # EmptyState, ErrorState, LoadingSkeleton, Toast, ConfirmDialog, Icon
│   │   ├── src/styles/tokens.css    # токены из DESIGN_SYSTEM.md (с поправкой контраста)
│   │   ├── src/lib/api/             # typed client + mock adapter (Фаза 1) → real (Фаза 2)
│   │   └── tests/ (Vitest) + e2e/ (Playwright)
│   └── api/
│       ├── app/{main.py,config.py,deps.py,security/,routers/,schemas/,models/,services/}
│       ├── app/services/{consent,suppression,outbox,approval,scoring,dedupe,importing}/
│       └── alembic/  pyproject.toml (uv)  tests/
├── workers/{celery_app.py,discovery,enrichment,scoring,drafting,communications,classification}/
├── integrations/{sources,channels,ai}/
├── packages/{contracts,prompts,design-system}/
├── infra/{compose,caddy,wireguard,systemd,backup,deploy}/   # без ключей в git
├── docs/{DECISIONS.md,IMPLEMENTATION_PLAN.md,TASKS.md,OPERATIONS.md,SECURITY.md,SOURCES_AND_LICENSES.md,CONSENT_POLICY.md,API.md,ACCEPTANCE.md,design-reference/}
├── tests/{unit,integration,e2e,security,fixtures}/
├── .github/workflows/{ci.yml,deploy.yml}
└── .env.example  Makefile  docker-compose.dev.yml  README.md
```
Менеджеры пакетов: `pnpm` (workspace) и `uv` (Python) — бесплатные.

---

## 5. Этапы (CLAUDE §12, ТЗ §16) и оценка

Оценка ТЗ: 3–5 недель одного разработчика; срок не гарантирую. Каждая фаза закрывается отчётом (файлы, команды, вывод тестов, скриншоты, риски) и **вашим подтверждением** перед следующей.

| Фаза | Содержание | Критерий приёмки |
|---|---|---|
| **0** (сейчас) | Аудит, ADR, план, список доступов | Вы ответили на «?», выдали минимум доступов |
| **1** Frontend | Next.js, токены, 8 разделов + login + карточка, mock-adapter с меткой «Демо», состояния loading/empty/error/denied/no-AI/offline, адаптив 360–1440, a11y | Скриншоты desktop+mobile прототип vs реализация, исправленные отклонения, lint/tsc/vitest/build зелёные, 0 мёртвых кнопок |
| **2** Backend & data | FastAPI, Alembic, Postgres, сессии+CSRF+rate limit (+TOTP), companies/evidence/CSV-XLSX импорт и дедуп, подключение UI | 100 тестовых компаний без потерь, дубли помечены, pytest зелёный |
| **3** Discovery | Source policy registry, SSRF-safe crawler, Celery-задачи, отмена/ретраи, rule-scoring 0–100 с объяснением | SSRF-набор проходит, scoring объясним |
| **4** AI optional | Provider interface, бюджет, schema-validation, evidence-привязка, ручной export/import | 20 черновиков без выдуманных фактов; поломка AI не ломает CRM |
| **5** Approval & messaging | Approval state machine + hash, consent/suppression, outbox, IMAP/SMTP на тестовый ящик, классификация, opt-out | 100% отправок без права блокируются на сервере; отписка → suppression |
| **6** Deploy/QA | Compose VPS-1/2, WireGuard, Caddy HTTPS, CI/CD с ручным promotion и откатом, бэкап+restore, мониторинг, e2e/security, ACCEPTANCE | **Только после вашего разрешения** на production |

---

## 6. Тестовые ворота

Unit (нормализация, дедуп, scoring, хэш черновика, consent, suppression, переходы, идемпотентность) · Integration (CSV, evidence, auth, replay job, webhook dedup, outbox) · Security (SSRF/rebinding/redirect, подпись webhook, CSRF, XSS, rate limit, утечки секретов, SQLi-baseline, PII в логах) · E2E Playwright 390×844 (вход → импорт → скоринг → черновик → approve → blocked без согласия → отправка на тестовый consented-ящик → ответ → классификация → отписка) · Ops (рестарт, restore, rollback миграций, падение worker/Redis).
Не заявляю «работает» без запущенного теста; результаты показываю как есть.

---

## 7. Бюджет

Дополнительные расходы: 0 ₽ по умолчанию (OSS-стек, Let's Encrypt, GHCR/Actions в бесплатных лимитах — **лимиты приватного репо проверю до Фазы 6**). Платное — только после вашего «да»: AI API (лимит по умолчанию 50 ₽/день, 1 500 ₽/мес — настраиваемые гипотезы), источники данных, объектное хранилище бэкапов, домен, если его нет.

---

## 8. Диагностика VPS — read-only команды (выполните сами, вывод без паролей/ключей пришлите)

```bash
# Выполнять на каждом VPS. Ничего не меняют.
cat /etc/os-release | head -3; uname -r; nproc; free -h; df -h /
uptime; who; ss -tlnp 2>/dev/null | head -40          # открытые порты
docker ps -a 2>/dev/null; docker compose ls 2>/dev/null
systemctl list-units --type=service --state=running --no-pager | head -40
sudo ufw status verbose 2>/dev/null; sudo iptables -S 2>/dev/null | head -20
ls /etc/nginx/sites-enabled /etc/caddy 2>/dev/null
curl -s ifconfig.me; echo                              # внешний IP
```
Для DNS: `dig +short A <поддомен>`. **Не присылайте** пароли root, приватные SSH-ключи, токены, cookies, 2FA-коды.

---

## 9. Что нужно от вас

Решения: (1) без Tailwind/shadcn · (6) Caddy · (7) ручное утверждение деплоя · (11) шрифты Manrope+Inter.

Доступы/данные:
1. Для каждого VPS: провайдер, **страна дата-центра**, ОС, вывод команд из п. 8, что уже запущено и **что нельзя трогать**.
2. Домен и поддомены, кто управляет DNS.
3. GitHub: репозиторий (этот `Test` подойдёт — приватный?), право настроить Environments и Secrets. Секреты вносите сами в GitHub/на VPS.
4. Рабочий почтовый ящик для теста (провайдер, OAuth или app-password) — понадобится в Фазе 5.
5. Источник компаний: ваш CSV или разрешённый источник; пока работаем с CSV и демо.
6. Текст про AutoFlow: польза, пилот, цена, demo URL.
7. Режим AI на старте: рекомендую «без AI».
8. Подтверждение, что вы сами проверили юридические требования (38-ФЗ ст.18, 152-ФЗ, локализация, РКН) до включения реальных контактов — до тех пор отправка остаётся выключенной.

## 10. Риски

Юридические (согласие/ПД/локализация) · лицензии источников (только CSV до проверки) · RAM на 4 ГБ (замер в Фазе 6) · нет отдельного staging-сервера · обход ограничений каналов не реализуется намеренно, часть каналов останется `manual_only` · объём (8 экранов + ≥7 новых) — возможен сдвиг сроков.
