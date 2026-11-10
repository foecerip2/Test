# ARCHITECTURE

Статусы: **реализовано / частично / запланировано**. Решения и обоснования — `docs/decisions/0001-mvp-architecture.md`.

## Компоненты

```
Browser ──HTTPS──> Caddy ──> Next.js (apps/web)          [частично: UI + dev fixtures]
                       └──> FastAPI (apps/api)            [запланировано, Фаза 2]
                               ├── PostgreSQL 16          [запланировано, Фаза 2]
                               ├── LLM adapter (BYOK/Credits)  [Фаза 3]
                               └── jobs (PG queue) ──> Worker (concurrency=1) ──SSH──> VPS клиента  [Фаза 4]
```

## Слои web (apps/web)

- `app/(auth)/login` — вход; `app/(app)/*` — все экраны внутри `AppShell`.
- `components/ui` — примитивы на Radix + CVA, стилизованы токенами.
- `components/layout` — `AppShell`, `SideNav`, `MobileBottomNav`, `PageHeader`, `DemoRibbon`.
- `features/*` — доменные компоненты (ServerCard, ActionPlanCard, ConfirmActionDialog, EventLog …).
- `lib/api` — типизированный клиент `/api/v1`. Возвращает `Result<T>`; при недоступном бэкенде — `backend_unavailable`, UI показывает `ErrorState`.
- `fixtures/dev` — dev-моки, подключаются только при `NEXT_PUBLIC_DEV_FIXTURES=1` через `lib/api/source.ts`.
- `styles/tokens.css` — единственный источник цветов/радиусов (V2 §16.1).

## Поток данных (целевой вертикальный срез)

login → server (SSH host-key pin) → read-only metrics → AI chat → action plan (hash) → approval → job → worker → verified result. Сейчас готов только UI-слой поверх fixtures.

## Граница ответственности AI

AI возвращает только структурированные вызовы из каталога; policy engine и Pydantic-валидатор (Фаза 3) решают, допустимо ли; мутации исполняет только worker после approval с проверкой hash/revision/expiry. В web-слое ответы AI — данные, не код.

## БД и API

MD §6–7; миграции появятся в Фазе 2 (`apps/api/alembic`).
