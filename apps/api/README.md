# LeadHunter API

FastAPI + SQLAlchemy 2 + Alembic + PostgreSQL. Вход и регистрация по email и одноразовому коду, без паролей.
Описание контракта и переменных окружения: [`docs/API.md`](../../docs/API.md).

## Локальный запуск

```bash
cd apps/api
python3.12 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"

export ENV=dev OWNER_EMAIL=you@example.com
export DATABASE_URL=sqlite+pysqlite:///./dev.db     # или postgresql://user:pass@localhost/leadhunter
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

В dev по умолчанию `MAIL_BACKEND=console`: код входа печатается в лог сервера (только при `ENV=dev`).

## Проверки

```bash
ruff check . && ruff format --check .
mypy
pytest            # SQLite, Docker не нужен
```

## Проверка SMTP

```bash
SMTP_HOST=smtp.example.com SMTP_PORT=465 SMTP_USER=... SMTP_PASSWORD=... \
SMTP_FROM="LeadHunter <noreply@example.com>" MAIL_BACKEND=smtp \
python -m app.cli send-test-mail you@example.com
```

## Docker

```bash
docker build -t lh-api apps/api
```

Контейнер выполняет `alembic upgrade head`, затем `uvicorn` (1 worker, порт 8000).
Секреты (`SECRET_KEY`, `DATABASE_URL`, `SMTP_PASSWORD`) передаются только через окружение.
