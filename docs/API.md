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
| 410 | `CODE_EXPIRED` | код/challenge истёк или не существует |
| 410 | `CODE_USED` | код уже использован |
| 422 | `VALIDATION_ERROR` | неверный формат запроса/email |
| 429 | `RATE_LIMITED` | лимит запросов (заголовок `Retry-After`) |
| 429 | `TOO_MANY_ATTEMPTS` | 5 неверных попыток, нужен новый код |
| 503 | `MAIL_UNAVAILABLE` | SMTP недоступен, код не выдан |
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
| `MAIL_BACKEND` | `console` | `smtp` или `console`; `console` запрещён в prod |
| `SMTP_HOST`, `SMTP_PORT` (465), `SMTP_USER`, `SMTP_PASSWORD` | — | параметры SMTP |
| `SMTP_FROM` | — | например `LeadHunter <noreply@vaylonet.ru>` |
| `SMTP_SECURITY` | `ssl` (`starttls` для порта 587) | `ssl`, `starttls`, `none` |

Проверка SMTP: `python -m app.cli send-test-mail you@example.com`.
