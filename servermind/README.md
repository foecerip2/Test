# ServerMind

AI-системный администратор для Ubuntu VPS. **Статус: Фазы 0–1 (документация и web-интерфейс). Backend, SSH, AI, worker, биллинг — не реализованы.** Подробно: [`TASKS.md`](TASKS.md).

- [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) · [`ARCHITECTURE.md`](ARCHITECTURE.md) · [`SECURITY.md`](SECURITY.md) · [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md) · [`docs/decisions/`](docs/decisions)

## Запуск web (локально)
```bash
make install            # npm ci в apps/web
make dev                # http://localhost:3000, dev-фикстуры (ribbon «Демо-данные»)
make test               # юнит-тесты
make e2e                # собирает production и fixtures и гонит Playwright
make shots              # скриншоты в docs/design/screenshots
```
Без `NEXT_PUBLIC_DEV_FIXTURES=1` приложение работает как production: API ещё нет, поэтому экраны показывают «Сервис недоступен», а не демо-данные.

Сценарии состояний в fixtures-режиме: `?demo=loading|error|empty|nohistory`.

## Безопасность
Приложение ничего не выполняет на серверах: SSH-кода в репозитории нет. Не передавайте секреты в чат и не коммитьте `.env`.

Это подкаталог репозитория `Test`; соседние проекты (`vaylo/`, `docs/`) не затронуты.
