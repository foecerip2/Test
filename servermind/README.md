# ServerMind

AI-системный администратор для Ubuntu VPS. **Статус: Фазы 0–3.** Есть web-интерфейс и backend (вход, 2FA, тенанты, подключение серверов по SSH только на чтение, AI-чат с BYOK, планы и подтверждения). Исполнение изменений (worker), деплой, кредиты — не реализованы: подтверждение плана пока только записывает согласие. AI-адаптеры не проверялись живыми ключами. Подробно: [`TASKS.md`](TASKS.md).

[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) · [`ARCHITECTURE.md`](ARCHITECTURE.md) · [`SECURITY.md`](SECURITY.md) · [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md) · [`docs/decisions/`](docs/decisions)

## Установка на VPS и автообновление
Одна команда установки и автоматическое обновление при каждом обновлении GitHub (VPS сам забирает новый релиз: бэкап БД → миграции → smoke → откат при сбое; в GitHub нет доступа к серверу). Подробно — [`docs/operations/deployment.md`](docs/operations/deployment.md), решение — [ADR 0003](docs/decisions/0003-auto-deploy.md). **Реальный запуск на VPS ещё не выполнялся** (проверено на поддельном docker и статическими проверками).
```bash
sudo bash install.sh --image-repo ghcr.io/<owner>/servermind --dry-run   # сначала план: ничего не меняет
```

## Web (apps/web)
```bash
make install && make dev      # dev-фикстуры, ribbon «Демо-данные»
make test                     # vitest
make e2e                      # Playwright: fixtures + production
```
Без `NEXT_PUBLIC_DEV_FIXTURES=1` веб работает как production: данные только из API, при недоступности — честная ошибка.

## API (apps/api)
Python ≥3.12 (в песочнице проверено на 3.13), PostgreSQL 16.
```bash
cd apps/api && python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
export DATABASE_URL=postgresql+psycopg://USER:PASS@127.0.0.1:5432/servermind
export ENCRYPTION_MASTER_KEY=$(python3 -c "import os,base64;print(base64.b64encode(os.urandom(32)).decode())")  # хранить вне git и БД!
alembic upgrade head
SM_PASSWORD='не менее 12 символов' python -m app.cli create-user --email you@example.com --role owner
uvicorn app.main:app --port 8000         # для http-разработки добавьте COOKIE_SECURE=false
python -m pytest                          # нужна тестовая БД (см. tests/conftest.py)
```
Регистрации в вебе нет (закрытая бета): пользователей создаёт владелец через CLI. При первом входе owner/operator обязаны настроить 2FA.

## Проверка на реальном VPS (read-only)
Нужна машина, из которой доступен SSH-порт сервера (облачная песочница разработки такого доступа не имеет). **Ничего не меняется на сервере**: выполняются только 7 фиксированных команд чтения.
1. На сервере (вы, от root/sudo) создайте пользователя и добавьте ключ сервиса — ключ выдаёт `python -m app.cli public-key --email you@example.com` (или экран «Добавить сервер»):
   `adduser --disabled-password --gecos "" servermind`, затем добавьте ключ в `/home/servermind/.ssh/authorized_keys` (права 700/600). Без sudo и группы docker.
2. `python -m app.cli check-host --email you@example.com --host IP --username servermind` → покажет отпечаток ключа хоста; сверьте с `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`.
3. Повторите с `--fingerprint SHA256:…` → CLI подключится и выведет ОС, uptime, CPU, RAM, диск, службы (JSON).
Пароль root не используется нигде.

**Вход под root (по желанию владельца).** В мастере «Добавить сервер» можно указать пользователя `root`: нужна явная галочка о риске (ключ ServerMind получит полный доступ root; через API — поле `acceptRootRisk`, в CLI — `--accept-root-risk`). Ключ добавляется в **`/root/.ssh/authorized_keys`** (домашний каталог root — `/root`, а не `/home/root`), в `sshd_config` должен быть разрешён вход root по ключу (`PermitRootLogin prohibit-password`). Что выполняет ServerMind, от пользователя не зависит: фиксированный список команд чтения. Рекомендуется всё же отдельный пользователь.

## Stack e2e (браузер → Next → FastAPI → PostgreSQL)
Поднимите API на :8010 (пользователь `owner@example.com`, пароль `STACK_PASSWORD`), соберите web с `API_BASE_URL=http://127.0.0.1:8010 NEXT_DIST_DIR=.next-stack npx next build`, запустите `NEXT_DIST_DIR=.next-stack npx next start -p 3300`, затем `npx playwright test --project=stack`.

## Безопасность
На серверах ничего не выполняется и не изменяется. Секреты — только в окружении (`.env.example` содержит плейсхолдеры). Это подкаталог репозитория `Test`; соседние проекты не затронуты.
