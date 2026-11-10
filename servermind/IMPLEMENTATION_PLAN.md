# IMPLEMENTATION_PLAN

Источник: `SERVERMIND_CLAUDE_MASTER_PLAN_V2.md` §9, §12, §17. Фазы не перескакиваются; у каждой есть gate.

## Требования, противоречия и принятые решения

| Вопрос | Решение |
|---|---|
| §2 (палитра V1) vs §16 (палитра V2) | Источник истины — §16.1/V2; `tokens.css` содержит только V2 |
| PNG показывает «GPT-4.1», «Pro (MVP)», «4 320 кредитов», IP, «Иван» | Это концепт, не данные. В UI такие значения появляются только в fixtures с ribbon «Демо-данные» |
| PNG: волнообразные чарты, прогресс 62% | Реальные графики только из измерений; fixtures подписаны; пусто → «Недостаточно данных» |
| PNG: кнопка «Пополнить» | disabled + «Скоро» (§2.3 п.12) |
| Storybook | не делаем (§9 Фаза 1) |
| «Новый репозиторий» | Подкаталог `servermind/` (ADR 0001 п.11) |
| §8 `operations/[id]/page.tsx` vs §2.3 `/operations/[id]/approve` | Реализуем оба маршрута |
| Библиотеки анимаций из PNG (Rive, Lottie, Magic UI, Aceternity) | Не подключаем, §16.5 + `docs/ADR-motion.md` |
| Референс-промпт требует «ссылки на анимации» в дизайн-системе | Перечислены в `DESIGN_SYSTEM.md` как справочные, не как зависимости |

## Фазы и gate

| Фаза | Содержание | Gate | Статус |
|---|---|---|---|
| 0 | Preflight, ADR, threat model, структура, deps | Документация + воспроизводимый dev, без SSH-эффектов | см. TASKS.md |
| 1 | Токены, shell, все экраны, состояния, mobile, fixtures, Playwright-скриншоты | Все маршруты открываются, нет overflow на 320–360, smoke a11y | см. TASKS.md |
| 2 | FastAPI, Postgres, auth/2FA, tenant-check, onboarding SSH, read-only метрики | Fingerprint mismatch блокирует; IDOR закрыт; метрики реальные | не начата |
| 3 | AI chat, BYOK, plans, approvals, policy | Мутации без approval невозможны даже при prompt injection | не начата |
| 4 | Worker + очередь, Docker install, managed template, Caddy/HTTPS | Чистый VPS → plan → approve → HTTPS-сайт; идемпотентность | не начата; нужно отдельное разрешение владельца |
| 5 | Credits ledger, квоты, admin, QA, performance, backup drill | ≥10 E2E и security-тестов, замеры 1 vCPU/4 ГБ | не начата |
| 6 | VibeForge API | после MVP | вне объёма |

## Инвентарь экранов (15 маршрутов)

`/login`, `/onboarding`, `/dashboard`, `/servers`, `/servers/new`, `/servers/[id]`, `/assistant`, `/operations`, `/operations/[id]`, `/operations/[id]/approve`, `/deploy`, `/monitoring`, `/billing`, `/settings`, `/admin`.

## Карта компонентов (§16.2)

- Layout: AppShell, SideNav, MobileBottomNav, PageHeader, WorkspaceSwitch, DemoRibbon.
- Данные: StatCard, ServerCard, UsageMeter, MetricSparkline, StatusBadge, ServerPicker, CreditsBalance, BYOKProviderCard.
- AI/операции: AssistantComposer, AgentStepTimeline, ActionPlanCard, RiskBanner, ConfirmActionDialog, ExecutionProgress, EventLog, DeployWizard.
- Служебные: SecretInput, EmptyState, ErrorState, SkeletonBlock, NotificationToast, KeyboardShortcutHint.

## Вертикальный срез (§12.2)

login → сервер → read-only метрики → AI chat → plan → approval → executor → результат. Фаза 1 строит UI-слой среза; бэкенд — с Фазы 2.

## Требует подтверждения владельца

Любые live SSH-операции, изменения VPS (firewall, Docker, systemd, nginx/caddy), публичный деплой, оплаты, реальные ключи провайдеров.
