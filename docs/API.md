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
