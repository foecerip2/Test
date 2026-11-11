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
| 403 | `ORIGIN_FORBIDDEN` | Origin/Referer не совпадает с `PUBLIC_ORIGIN` |
| 404 | `NOT_FOUND` | нет ресурса |
| 409 | `LAST_OWNER` | блокировка последнего owner |
| 409 | `STAGE_CONFLICT` | `expected_stage` не совпал с текущей стадией (`current_stage` в ответе) |
| 409 | `SUPPRESSION_PERMANENT` | стадию `lost` (отказ) нельзя вернуть |
| 409 | `INVALID_STATE` | недопустимый переход состояния (отклонить архивную компанию) |
| 409 | `IMPORT_CONFLICT` | данные изменились во время импорта, три попытки не помогли |
| 413 | `PAYLOAD_TOO_LARGE` | тело импорта больше 2 МБ |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | импорт: не `text/csv` и не JSON |
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

## Здоровье (без авторизации, вне префикса)

- `GET /healthz` — liveness; `GET /readyz` — проверка БД.

## CSRF и Origin

Все мутации (POST/PUT/PATCH/DELETE): если есть `Origin` (или `Referer`), он должен совпадать с `PUBLIC_ORIGIN`. Мутации с сессией (кроме `/auth/otp/*`) требуют заголовок `X-CSRF-Token`, равный cookie `lh_csrf` (и подписанному токену сессии). `GET /auth/me` пересоздаёт `lh_csrf`, если cookie потеряна.

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
