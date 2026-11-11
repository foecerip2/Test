# API LeadHunter (`apps/api`)

Префикс `/api/v1`, JSON. Реализация: FastAPI, SQLAlchemy 2, Alembic, PostgreSQL. Аутентификация: email + одноразовый код, серверная сессия в cookie.

## Формат ошибок

```json
{"code": "INVALID_CODE", "message": "Неверный код.", "request_id": "…", "attempts_left": 3}
```

`attempts_left` есть только у `INVALID_CODE`. Заголовок `X-Request-ID` дублирует `request_id`.

| HTTP | code | Когда |
|---|---|---|
| 400 | `INVALID_CODE` | неверный код (`attempts_left`) |
| 400 | `CANNOT_BLOCK_SELF` | owner блокирует себя |
| 401 | `UNAUTHENTICATED` | нет/просрочена/отозвана сессия |
| 403 | `ACCOUNT_PENDING` | аккаунт ждёт одобрения (бизнес-эндпоинты) |
| 403 | `ACCOUNT_BLOCKED` | аккаунт заблокирован (verify) |
| 403 | `FORBIDDEN` | не owner |
| 403 | `CSRF_FAILED` | нет/неверный `X-CSRF-Token` |
| 403 | `ORIGIN_FORBIDDEN` | Origin/Referer не совпадает с `PUBLIC_ORIGIN` (для публичной формы пилота — с `AUTOFLOW_ORIGINS`; там Origin/Referer обязателен) |
| 404 | `NOT_FOUND` | нет ресурса |
| 409 | `LAST_OWNER` | блокировка последнего owner |
| 409 | `STAGE_CONFLICT` | `expected_stage` не совпал с текущей стадией (`current_stage` в ответе) |
| 409 | `SUPPRESSION_PERMANENT` | стадию `lost` (отказ) нельзя вернуть |
| 409 | `INVALID_STATE` | недопустимый переход состояния (отклонить архивную компанию) |
| 409 | `IMPORT_CONFLICT` | данные изменились во время импорта, три попытки не помогли |
| 413 | `PAYLOAD_TOO_LARGE` | тело импорта больше 2 МБ; тело заявки на пилот больше 8 КБ |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | импорт: не `text/csv` и не JSON; заявка на пилот: не `application/json` |
| 422 | `INVALID_CURSOR` | курсор повреждён или от другой сортировки |
| 422 | `EMPTY_FILE` | в CSV нет строк с данными |
| 422 | `TOO_MANY_ROWS` | больше 5000 строк данных |
| 422 | `MISSING_COLUMNS` | нет колонок «название»/«город» (`missing_columns`) — только commit |
| 422 | `INVALID_ENCODING` | файл не UTF-8 и не cp1251 |
| 410 | `CODE_EXPIRED` | код/challenge истёк или не существует |
| 410 | `CODE_USED` | код уже использован |
| 422 | `VALIDATION_ERROR` | неверный формат запроса/email |
| 429 | `RATE_LIMITED` | лимит запросов (заголовок `Retry-After`) |
| 429 | `TOO_MANY_ATTEMPTS` | 5 неверных попыток, нужен новый код |
| 503 | `MAIL_UNAVAILABLE` | почта (SMTP или HTTPS-ретранслятор) недоступна, код не выдан |
| 503 | `NOT_READY` | `/readyz`: БД недоступна |
| 500 | `INTERNAL_ERROR` | внутренняя ошибка |

## Вход

- `POST /auth/otp/request` `{email}` → `202 {challenge_id, expires_in: 600, resend_in: 60}`. Ответ одинаков для нового и существующего email. Лимиты: 1/60 с и 5/час на email, 20/час на IP (хранятся в БД, таблица `rate_limits`).
- `POST /auth/otp/verify` `{challenge_id, code}` → `200 {user:{id,email,role,status}, is_new}` + cookie `lh_session` (HttpOnly, SameSite=Lax, Path=/, 30 дней; `Secure` при `COOKIE_SECURE`) и `lh_csrf` (не HttpOnly). Код: 6 цифр, TTL 10 мин, одноразовый, максимум 5 неверных попыток на challenge.
- `POST /auth/otp/resend` `{challenge_id}` → `202 {resend_in: 60}`. Тот же challenge, новый код, старый недействителен; cooldown 60 с; максимум 5 отправок на challenge.
- `GET /auth/me` → `200 {user}` или `401`.
- `POST /auth/logout` (CSRF) → `204`, сессия отзывается.

Роли: пользователь с `OWNER_EMAIL` при первой верификации получает `role=owner, status=active`; остальные `role=user, status=pending`. Пока `OWNER_EMAIL` пуст, owner не назначается никому. Бизнес-эндпоинты используют зависимость `require_active_user` (пример: `GET /api/v1/ping`).

## Администрирование (только owner)

- `GET /admin/users`
- `POST /admin/users/{id}/approve` (CSRF) → `status=active`
- `POST /admin/users/{id}/block` (CSRF) → `status=blocked`, сессии отозваны. Нельзя заблокировать себя и последнего owner.

## Компании (Фаза 2)

Все эндпоинты требуют активного пользователя (`require_active_user`: 401 без сессии/заблокирован, 403 `ACCOUNT_PENDING`). Мутации — ещё CSRF (`X-CSRF-Token`). Пока все активные пользователи видят общую базу компаний (single-tenant). Поля ответов — **snake_case**, как в auth; даты — ISO 8601 UTC (`2026-11-10T12:00:00Z`). Соответствие `apps/web/src/lib/api/types.ts` (camelCase): `source_label`→`sourceLabel`, `updated_at`→`updatedAt`, `has_more`→`hasMore`, `next_cursor` (новое), `score_reasons`→`scoreReasons`, `score_version`→`scoreVersion`, `evidence_url`→`evidenceUrl`, `evidence_excerpt`→`evidenceExcerpt`, `observed_at`→`observedAt`, `draft_id`→`draftId`; остальные имена совпадают. Конвертацию делает клиент.

Объект компании (`Company`):

```json
{"id": "uuid", "name": "Север Авто", "city": "Казань", "category": "Автосервис",
 "website": "https://sever.example", "domain": "sever.example", "inn": "7707083893",
 "state": "discovered", "stage": "new", "score": 35,
 "display": {"key": "new", "label": "Новый", "tone": "neutral"},
 "source_label": "Импорт CSV", "created_at": "…", "updated_at": "…",
 "demo": false, "duplicate_candidate": false}
```

`state` — машина состояний ТЗ §8 (`discovered|verified|scored|shortlisted|rejected|archived`), `stage` — стадия CRM (`new|contacted|replied|interested|pilot|lost`). `display` вычисляется из `state`+`stage`: `lost`→`refused` («Отказ», red), `rejected`→«Отклонена» (red), `pilot`/`interested`→green, `replied`/`contacted`/`new`→neutral. Ключи `display.key` — значения параметра `status`.

### `GET /companies`

Параметры: `query` (поиск по названию, городу, категории, домену; без учёта регистра и «ё»), `city` (нормализуется: «СПб», «г. Казань» работают), `score_min` (0–100), `status` (`new|contacted|replied|interested|pilot|refused|rejected`), `sort` (`score|name|updated`, по умолчанию `score`), `dir` (`asc|desc`; по умолчанию `desc` для `score`/`updated`, `asc` для `name`), `limit` (1–200, по умолчанию 50), `cursor`.

```json
{"items": [Company, …], "total": 128, "cities": ["Казань", "Уфа"], "has_more": true, "next_cursor": "eyJz…"}
```

`total` — число записей по фильтрам (не зависит от курсора); `cities` — все города базы. Пагинация курсорная (keyset): сортировка всегда по `(поле, id)`, поэтому при равных оценках порядок стабилен, страницы не пересекаются и не теряют записи. Курсор привязан к `sort`/`dir`; чужой или повреждённый — `422 INVALID_CURSOR`. Клиент передаёт `next_cursor` как есть и не разбирает его.

### `GET /companies/{id}`

`Company` + поля:

```json
{"note": "", "facts": [{"id": "…", "text": "…", "kind": "confirmed", "evidence_url": "https://…",
  "evidence_excerpt": "…", "observed_at": "…", "confidence": 0.9}],
 "score_reasons": [{"rule": "business_type", "label": "Тип бизнеса", "points": 25, "max": 25, "note": "Автосервис / СТО"}],
 "score_version": "rules-v1",
 "history": [{"id": "…", "event_type": "company.imported", "icon": "download", "title": "Импортирована из CSV",
  "text": "Строка 2", "at": "…", "company_id": "…", "company_name": null}],
 "contacts": [], "draft_id": null}
```

Факты отсортированы: сначала `confirmed` (у них всегда есть `evidence_url` и `evidence_excerpt`), затем `hypothesis`; внутри — по `observed_at` убыв. Разбор оценки — шесть правил с весами 25/20/15/15/15/10 (`rules-v1`), `sum(points) == score`. `history` — до 50 последних событий (`activity_events`, в payload нет персональных данных и текстов заметок). `contacts` и `draft_id` — заглушки до следующих шагов.

### `PATCH /companies/{id}` (CSRF)

`{"stage"?: …, "note"?: "≤ 2000 символов", "expected_stage"?: …}`; нужен `stage` или `note`; лишние поля — 422. Ответ — карточка. `expected_stage` — оптимистичная проверка: если текущая стадия иная, `409 STAGE_CONFLICT` с `current_stage`; запись выполняется как compare-and-set (`UPDATE … WHERE stage = <прочитанная>`), так что параллельное изменение не затирается. Повтор той же стадии — без события. Переход из `lost` в другую стадию — `409 SUPPRESSION_PERMANENT`; при переходе в `lost` оценка пересчитывается (правило «чисто» даёт 0) и пишется событие `company.score_recalculated`. Тексты заметок в журналы не попадают (только длина).

### `POST /companies/{id}/reject` (CSRF)

`state → rejected`, ответ — карточка. Повтор идемпотентен (без новых событий); архивную компанию — `409 INVALID_STATE`.

### `GET /companies/export`

Те же `query/city/score_min/status/sort/dir`, без `limit/cursor`. `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="companies.csv"`, потоковая выдача. Формат как у `toCsv` эталона: BOM, разделитель `;`, `CRLF`, все ячейки в кавычках, значения на `= + - @ TAB CR` получают префикс `'` (защита от CSV-инъекций). Колонки: Компания, Город, Категория, Сайт (домен), Оценка, Статус. Каждая выгрузка пишется в `audit_logs` (`company.export`).

### `POST /imports/companies?dry_run=true|false` (CSRF)

Тело: `text/csv` (UTF-8, при ошибке декодирования — cp1251) **или** `application/json` `{"text": "…"}`. Лимиты: 2 МБ (`413`, проверяется и по `Content-Length`, и при чтении потока; тело неавторизованного не читается) и 5000 строк данных. Разделители `;` `,` TAB, BOM, кавычки RFC 4180. Колонки: `название`/`name`/`компания`…, `город`/`city`, необязательные `категория`, `сайт`/`url`, `инн`. `dry_run` по умолчанию `true`.

Dry-run ничего не пишет (ни компаний, ни `import_jobs`, ни аудита):

```json
{"dry_run": true, "missing_columns": [],
 "rows": [{"line": 2, "name": "Север Авто", "city": "Казань", "category": "Автосервис", "website": "sever.example",
   "inn": null, "issues": [], "duplicate": null}],
 "summary": {"total": 1, "importable": 1, "with_issues": 0, "exact": 0, "in_file": 0, "candidates": 0}}
```

`duplicate`: `{"kind": "exact"|"candidate"|"in_file", "of": "название"}`. Порядок дедупликации (ТЗ §6): ИНН → домен+город (точные дубли) → похожее нормализованное название в том же городе (**только кандидат**, не слияние). Филиалы одного домена в разных городах не сливаются. Дубли внутри файла — `in_file`; строки с ошибками не занимают ключ дедупликации. Если нет колонок «название»/«город», dry-run отвечает `200` с `missing_columns` и пустым `rows`.

Commit (`dry_run=false`) не принимает от клиента ни `issues`, ни `duplicate`: сервер заново разбирает файл и сверяет с БД. Добавляются строки без ошибок и без точных дублей; «кандидаты» добавляются с `duplicate_candidate=true` (оценка −10, событие `company.duplicate_candidate`). Оценка только за то, что известно из файла: сайт не проверялся (`site_works=false`), онлайн-запись «не проверялась» (`null`), контактов нет — автосервис получает 35, прочие 10. Уникальность ИНН закреплена индексом БД; при гонке двух импортов commit повторяет планирование.

```json
{"dry_run": false, "job_id": "uuid", "rows_total": 3, "added": 2, "skipped": 1, "candidates": 0, "summary": {…}}
```

Файл не хранится: в `import_jobs` только счётчики. Каждый commit пишет `audit_logs` (`import.commit`) и события `company.imported` по каждой компании.

### `GET /dashboard`

Только агрегаты из БД (пустая база — нули):

```json
{"companies_total": 128, "companies_week": 12, "suitable": 9, "score_threshold": 75,
 "by_stage": {"new": 100, "contacted": 20, "replied": 4, "interested": 2, "pilot": 1, "lost": 1},
 "by_state": {"discovered": 120, "verified": 0, "scored": 0, "shortlisted": 0, "rejected": 7, "archived": 1},
 "top_companies": [Company, …], "recent": [{…событие…, "company_name": "…"}]}
```

`companies_week` — создано за 7 суток; `suitable` — `score ≥ порога`, без отклонённых и отказов; `top_companies` — до 4 лучших (без отклонённых и отказов); `recent` — 5 последних событий. Порог — `SCORE_THRESHOLD` (по умолчанию 75). Показатели, которых в БД пока нет (черновики, диалоги, задачи), в ответ не включены — UI должен их скрывать, а не рисовать нули.

`pilot_requests_new` — число заявок на пилот AutoFlow со статусом `new`; **только для owner**, у остальных пользователей `null`.

## Проверка сайтов, очередь, кампании, источники (Фаза 3)

Все эндпоинты — для активного пользователя (401 / 403 `ACCOUNT_PENDING`), мутации — с CSRF и записью в `audit_logs`. Ответы — snake_case, даты ISO 8601 UTC. Задачи выполняет отдельный процесс `python -m app.worker` (очередь в PostgreSQL, ADR-017); сам API сайты не загружает.

### `POST /companies/{id}/enrich` (CSRF) → `202 {"job_id": "uuid"}`
Ставит задачу `enrich_company`. `404` — нет компании; `422 NO_WEBSITE` — у компании нет сайта; `409 JOB_ALREADY_ACTIVE` (+ `job_id` существующей) — задача для этой компании уже в очереди или выполняется. Аудит: `company.enrich`.

Что делает задача: главная + до 4 внутренних страниц того же сайта (запись, контакты, услуги/цены), robots.txt, не чаще 1 запроса в 2 с. Старые факты источника `website` заменяются новыми; оценка пересчитывается по rules-v1; в историю пишутся `company.site_checked` и (если оценка изменилась) `company.score_recalculated`. Итог в `result` задачи:

```json
{"outcome": "checked|unreachable|skipped", "pages_checked": 4, "facts": 12, "score_before": 35, "score_after": 85,
 "site_works": true, "online_booking": "detected|not_detected|not_checked", "demand_signals": 3,
 "has_business_contact": true, "error_code": null}
```
`skipped` (robots запрещает, адрес недопустим, редирект на другой домен) — оценка не меняется. `online_booking = not_detected` — «не обнаружена», это не доказательство отсутствия. Телефоны и e-mail организации НЕ сохраняются: в карточке (`facts`) только «Опубликован телефон/e-mail организации» со ссылкой на страницу и маскированной выдержкой. Факты `confirmed` всегда с `evidence_url` и выдержкой ≤ 200 символов, остальное — `hypothesis`.

### `GET /jobs`, `GET /jobs/{id}`, `POST /jobs/{id}/cancel` (CSRF)
Параметры списка: `state` (`queued|running|succeeded|failed|cancelled`), `type` (сейчас только `enrich_company`), `limit` (1–200, по умолчанию 50), `cursor`. Сортировка — новые первыми; курсор непрозрачный, чужой/повреждённый — `422 INVALID_CURSOR`.

```json
{"items": [Job, …], "has_more": false, "next_cursor": null}
Job = {"id": "uuid", "type": "enrich_company", "state": "queued", "attempts": 0, "max_attempts": 3,
  "run_after": "…", "created_at": "…", "updated_at": "…", "cancel_requested": false,
  "company_id": "uuid|null", "campaign_id": "uuid|null", "last_error": null, "result": null}
```
`last_error` — без секретов и персональных данных. Повторы: максимум 3 попытки, задержка 30 с · 2^(n−1) ± 25 %; постоянные ошибки (нет сайта, неверные данные) не повторяются. `cancel`: `queued` → `cancelled` сразу; `running` → `cancel_requested=true`, воркер остановится между шагами (состояние станет `cancelled`); завершённая задача — `409 JOB_NOT_CANCELLABLE` (+ `state`). Аудит: `job.cancel`.

### Кампании
`POST /campaigns` (201), `GET /campaigns` → `{"items": [Campaign]}`, `GET /campaigns/{id}`, `PATCH /campaigns/{id}` `{"status": "paused"|"running"}`, `POST /campaigns/{id}/run`.

```json
{"name": "Казань, автосервисы", "regions": ["Казань"], "categories": ["автосервис"],
 "filter": {"score_min": 40}, "per_day_limit": 50}
Campaign = {"id": "uuid", "name": "…", "regions": [], "categories": [], "filter": {"score_min": null},
  "per_day_limit": 50, "status": "running|paused|done",
  "progress": {"enqueued_total": 10, "enqueued_today": 4, "last_run_at": "…|null", "jobs": {"queued": 2, "succeeded": 8}},
  "created_at": "…", "updated_at": "…"}
```
Ограничения: имя 1–120 символов, `regions`/`categories` ≤ 50 элементов, `per_day_limit` 1–1000, лишние поля — 422. `run` → `{"enqueued": 2, "skipped_active": 0, "remaining_today": 8, "status": "running"}`: ставит задачи для НЕпроверенных компаний (есть сайт; нет события `company.site_checked`; не отклонены, не «отказ»; город из `regions` (нормализуется) или регион; категория содержит одну из `categories` без учёта регистра; оценка ≥ `score_min`), по убыванию оценки, не более `per_day_limit` за UTC-сутки, без дублей (`skipped_active`). Приостановленная/завершённая кампания — `409 CAMPAIGN_NOT_RUNNING`. Когда подходящих компаний не осталось и задач нет, статус становится `done`. Задачи ставятся только вызовом `run` (автозапуска по расписанию пока нет). Аудит: `campaign.create|pause|resume|run`.

### `GET /sources`
```json
{"items": [{"id": "csv", "name": "…", "enabled": true, "description": "…", "rules": ["…"],
  "retention_days": 365, "disabled_reason": null},
 {"id": "public_websites", …, "enabled": true}, {"id": "catalogs", …, "enabled": false,
  "retention_days": null, "disabled_reason": "Включается только после проверки лицензии и условий источника."}]}
```
Подробности — `docs/SOURCES_AND_LICENSES.md`. Меры защиты загрузчика — `docs/SECURITY.md`.

## AutoFlow: заявки на пилот

Серверная часть формы «Хочу пилот» с лендинга AutoFlow. Таблица `pilot_requests` (миграция `0004`, аддитивная; откат `downgrade 0003` удаляет таблицу вместе с заявками).

### `POST /autoflow/pilot-requests` — публичный (без входа и без CSRF)

Запрос с другого origin (сайт AutoFlow). `Content-Type: application/json`, тело до 8 КБ:

```json
{"business_name": "Север Авто", "city": "Казань", "contact_name": "Иван Петров",
 "phone": "+7 (900) 123-45-67", "email": null, "consent": true, "website": "",
 "consent_text_version": "2026-11-v1"}
```

| Поле | Правила |
|---|---|
| `business_name` | строка 1–120 символов |
| `city`, `contact_name` | строка 1–80 символов; ссылки (`://`, `www.`, `t.me/`) не допускаются |
| `phone` | `null`/`""` или российский номер: `+7…`, `8…`, `7…`, 10 цифр (пробелы, скобки, дефисы, точки допустимы); хранится как `+7XXXXXXXXXX`; коды 3xx/4xx/8xx/9xx |
| `email` | `null`/`""` или корректный адрес (≤ 254), хранится в нижнем регистре |
| — | **хотя бы один** из `phone`/`email` |
| `consent` | строго `true` (булево) |
| `website` | honeypot, у людей `""`; любое непустое значение → `202` без записи |
| `consent_text_version` | необязательно, `[A-Za-z0-9._-]{1,32}`; по умолчанию `PILOT_CONSENT_VERSION` |

Текстовые поля: NFC, пробелы схлопываются; управляющие, bidi- и «невидимые» символы, `<` и `>` — отказ. Типы строгие (число вместо строки → `422`). Неизвестные поля игнорируются.

Ответ: **всегда `202 {"status": "accepted"}`** — одинаково для новой заявки, дубля и honeypot (ничего не раскрываем). Ошибки: `422 VALIDATION_ERROR` (без эха введённых данных), `415`, `413`, `403 ORIGIN_FORBIDDEN`, `429 RATE_LIMITED` (+ `Retry-After`).

- **Дедупликация:** тот же телефон ИЛИ e-mail за последние 24 ч (любой статус) → `202` без записи.
- **Лимиты** (скользящие, в таблице `rate_limits`): на хэш IP — 5/час и 20/сутки; общий — 300/сутки (`PILOT_IP_PER_HOUR`, `PILOT_IP_PER_DAY`, `PILOT_GLOBAL_PER_DAY`). Считаются и дубли; запросы с ошибкой валидации и honeypot — нет. IP хранится только как HMAC-хэш с `SECRET_KEY`.
- **Origin и CORS:** разрешены только источники из `AUTOFLOW_ORIGINS` (список через запятую) и `https://AUTOFLOW_DOMAIN`. По умолчанию список пуст — эндпойнт закрыт (любой запрос → `403`). `Origin` (или `Referer`) **обязателен** и должен совпасть; иначе `403 ORIGIN_FORBIDDEN`, заявка не создаётся. Для разрешённого источника в ответах (включая `422`/`429`) есть `Access-Control-Allow-Origin: <origin>`, `Vary: Origin`, `Access-Control-Expose-Headers: X-Request-ID, Retry-After`; без `Allow-Credentials`. Preflight `OPTIONS` → `204` (`Allow-Methods: POST, OPTIONS`, `Allow-Headers: Content-Type`, `Max-Age: 600`). Остальные эндпойнты CORS не получают, а мутации с Origin сайта AutoFlow получают `403`.
- Сохраняются также `consent_at`, `consent_text_version`, `ip_hash`, `user_agent_short` (≤ 120 символов); владельцу `ip_hash` и user-agent не отдаются.

### `GET /autoflow/pilot-requests` — только owner

Параметры: `status` (`new|contacted|accepted|declined|spam`), `limit` (1–100, по умолчанию 50), `cursor`. Порядок: новые сверху (`created_at`, `id` по убыванию). Курсор привязан к фильтру `status` (иначе `422 INVALID_CURSOR`).

```json
{"items": [{"id": "uuid", "business_name": "…", "city": "…", "contact_name": "…",
            "phone": "+79001234567", "email": null, "status": "new", "note": "",
            "consent_at": "…", "consent_text_version": "2026-11-v1",
            "created_at": "…", "updated_at": "…"}],
 "next_cursor": null}
```

Обычный пользователь — `403 FORBIDDEN`, ожидающий одобрения — `403 ACCOUNT_PENDING`, без входа — `401`.

### `PATCH /autoflow/pilot-requests/{id}` (CSRF) — только owner

Тело `{"status"?, "note"?}` (хотя бы одно поле; `note` ≤ 2000 символов, пустая строка очищает; другие поля → `422`). Ответ — заявка (как в списке). `404 NOT_FOUND` — нет такой заявки. Изменения пишутся в `audit_logs` (`pilot_request.update`: `status_from`/`status_to`, `note_changed`; текст заметки в аудит не попадает). Без изменений аудит не пишется.

### Персональные данные и аудит
Телефон, e-mail и имена хранятся только в `pilot_requests`. В логи и `audit_logs` не попадают: при создании пишется `pilot_request.created` с `entity_id` и признаками `has_phone`/`has_email`/`consent_text_version`. Уведомление владельца: счётчик `pilot_requests_new` в `GET /dashboard` и запись аудита; уведомления по e-mail — отдельным шагом (`docs/AUTOFLOW.md`).

## Здоровье (без авторизации, вне префикса)

- `GET /healthz` — liveness; `GET /readyz` — проверка БД.

## CSRF и Origin

Все мутации (POST/PUT/PATCH/DELETE): если есть `Origin` (или `Referer`), он должен совпадать с `PUBLIC_ORIGIN`. Единственное исключение — публичный `POST /autoflow/pilot-requests`: там проверка по `AUTOFLOW_ORIGINS` (см. выше). Мутации с сессией (кроме `/auth/otp/*`) требуют заголовок `X-CSRF-Token`, равный cookie `lh_csrf` (и подписанному токену сессии). `GET /auth/me` пересоздаёт `lh_csrf`, если cookie потеряна.

## Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `ENV` | `dev` | `dev` или `prod` |
| `DATABASE_URL` | sqlite-файл (только dev) | в prod обязателен PostgreSQL; `postgresql://` заменяется на `postgresql+psycopg://` |
| `SECRET_KEY` | dev-ключ | в prod обязателен, ≥ 32 символов; HMAC кодов, сессий, CSRF |
| `PUBLIC_ORIGIN` | `http://localhost:3000` | `https://ai.vaylonet.ru`; ссылки в письмах и проверка Origin |
| `COOKIE_SECURE` | `true` в prod | флаг `Secure` |
| `TRUST_PROXY_HEADERS` | `true` в prod | брать IP клиента из последней записи `X-Forwarded-For` (API должен быть доступен только через reverse proxy) |
| `OWNER_EMAIL` | пусто | email владельца |
| `SCORE_THRESHOLD` | `75` | порог оценки «подходит для работы» (0–100) для дашборда |
| `DATA_RETENTION_DAYS` | `365` | срок хранения данных источников (показывается в `/sources`; автоочистки пока нет) |
| `WORKER_CONCURRENCY` | `1` | число потоков воркера (1–2) |
| `WORKER_POLL_SECONDS` | `2` | пауза опроса пустой очереди |
| `JOB_LOCK_TIMEOUT_SECONDS` | `300` | через сколько «зависшая» задача возвращается в очередь |
| `WORKER_HEARTBEAT_FILE` | `/tmp/lh-worker.heartbeat` | файл для healthcheck воркера (`python -m app.worker --healthcheck`) |
| `AUTOFLOW_ORIGINS` | пусто | источники (через запятую, `https://host`, без путей и `*`; в prod только https), которым разрешена публичная форма пилота и CORS на ней; пусто — приём закрыт |
| `AUTOFLOW_DOMAIN` | пусто | домен лендинга AutoFlow (`autoflow.example.com`); добавляет `https://<домен>` к разрешённым источникам |
| `PILOT_CONSENT_VERSION` | `2026-11-v1` | версия текста согласия, если форма её не прислала |
| `PILOT_IP_PER_HOUR`, `PILOT_IP_PER_DAY`, `PILOT_GLOBAL_PER_DAY` | `5`, `20`, `300` | лимиты приёма заявок на хэш IP и общий |
| `ALLOW_PRIVATE_FETCH_FOR_TESTS` | `false` | только `ENV=dev`: отключает проверку адресов при загрузке сайтов (тесты на localhost); в prod — ошибка конфигурации |
| `MAIL_BACKEND` | `console` | `http` (HTTPS-ретранслятор, основной в prod), `smtp` или `console`; `console` запрещён в prod |
| `MAIL_RELAY_URL` | — | для `http`: адрес ретранслятора, в prod только `https://`, например `https://vaylonet.ru/lh-mail.php` |
| `MAIL_RELAY_SECRET` | — | для `http`: общий секрет HMAC, ≥ 32 символов; не попадает в repr/логи |
| `SMTP_HOST`, `SMTP_PORT` (465), `SMTP_USER`, `SMTP_PASSWORD` | — | параметры SMTP |
| `SMTP_FROM` | — | например `LeadHunter <noreply@vaylonet.ru>` |
| `SMTP_SECURITY` | `ssl` (`starttls` для порта 587) | `ssl`, `starttls`, `none` |

Проверка почты (любой backend): `python -m app.cli send-test-mail you@example.com`. Отправляется случайный 6-значный код (для `http` ретранслятор принимает только письма-коды); сам код в вывод не печатается.

### HTTPS-ретранслятор (`MAIL_BACKEND=http`)
Нужен, когда хостинг VPS закрывает исходящие порты 25/465/587. `HttpRelayMailer` (stdlib `http.client`, таймаут 15 с, проверка TLS, без редиректов) отправляет `POST` `application/json` `{"to","code","ttl_minutes"}` — и только это; тему и текст письма формирует PHP-скрипт `infra/mail-relay/lh-mail.php`.

Заголовки: `X-LH-Timestamp` (unix-секунды, допуск ±300 с), `X-LH-Nonce` (16–64 символа `[A-Za-z0-9_-]`, одноразовый), `X-LH-Signature` = hex HMAC-SHA256(`MAIL_RELAY_SECRET`, `timestamp + "." + nonce + "." + тело`). Любой ответ, кроме `200 {"ok":true}`, — `MailError` и 503 `MAIL_UNAVAILABLE` у клиента API. Совместимость схемы подписи с PHP проверяет `apps/api/tests/test_relay_compat.py` (маркер `integration`, пропускается без `php`).
