# LeadHunter AI

Приватный кабинет для поиска и квалификации автосервисов, согласования сообщений и контроля ответов. Сайт + Android-приложение.

Статус: **Фаза 1** (интерфейс на демо-данных) завершена; впереди Фаза 2 (backend, вход). Деплой: GitHub Actions → «Publish release» владельцем → сервер сам обновляется (`https://ai.vaylonet.ru`).

- Установка на сервер одной командой и регламент: [docs/OPERATIONS.md](docs/OPERATIONS.md)
- План и аудит: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) · Решения: [docs/DECISIONS.md](docs/DECISIONS.md) · Задачи: [docs/TASKS.md](docs/TASKS.md)
- Скриншоты (макет и реализация): [docs/screenshots/](docs/screenshots/)
- Исходный дизайн-пакет и ТЗ: [docs/design-reference/](docs/design-reference/)

Запуск разработки: `pnpm install && pnpm dev` (Node 22). Проверки: `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e`.
