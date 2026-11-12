# LeadHunter AI

Приватный кабинет для поиска и квалификации автосервисов, согласования сообщений и контроля ответов. Сайт + Android-приложение.

Статус: LeadHunter — вход, база компаний и серверная проверка сайтов (этап B); live-интерфейс кампаний/очереди ещё не подключён. Дальнейшая разработка — **AutoFlow**: лендинг, Android-оболочка, приём заявок на пилот и кабинет владельца `/autoflow/pilots`. Онлайн-запись и подписки — следующие этапы. Деплой: код попадает в `main` только с разрешения владельца → тесты → сервер сам обновляется (`https://ai.vaylonet.ru`).

- Установка на сервер одной командой и регламент: [docs/OPERATIONS.md](docs/OPERATIONS.md)
- План и аудит: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) · Решения: [docs/DECISIONS.md](docs/DECISIONS.md) · Задачи: [docs/TASKS.md](docs/TASKS.md)
- Скриншоты (макет и реализация): [docs/screenshots/](docs/screenshots/)
- Исходный дизайн-пакет и ТЗ: [docs/design-reference/](docs/design-reference/)

Запуск разработки: `pnpm install && pnpm dev` (Node 22). Проверки: `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e`.

AutoFlow: [план продукта](docs/AUTOFLOW.md) · [развёртывание](docs/AUTOFLOW_DEPLOY.md). CI-задача `test`, разрешающая автообновление сервера, также требует успешных проверок Python API.

AutoFlow: [закрытое приложение, вход, данные и проверки](docs/AUTOFLOW_APP.md) · [дизайн и аудит](docs/AUTOFLOW_REVIEW.md). `/app` открыт только администрации; новые регистрации остаются в ожидании.
