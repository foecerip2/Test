# TASKS

## Фаза 0 — аудит
- [x] Прочитаны все .md, HTML, CSS, JS пакета
- [x] Противоречия, ADR, архитектура, оценка ресурсов → `IMPLEMENTATION_PLAN.md`, `DECISIONS.md`
- [ ] Ответы владельца на ADR-001/004/007/009 и «Что нужно от вас» (IMPLEMENTATION_PLAN §9)
- [ ] Результаты read-only диагностики VPS (IMPLEMENTATION_PLAN §8)

## Фаза 1 — frontend (после согласования)
- [ ] pnpm-workspace, Next.js + TS strict, ESLint, Vitest, Playwright
- [ ] tokens.css (с исправленным контрастом) + шрифты self-host
- [ ] Компоненты: AppShell, Sidebar, Topbar, PageHeader, MetricCard, StatusTag, ScoreBadge, DataTable, EvidenceList, MessageEditor, ApprovalGate, Conversation*, KanbanColumn, ActivityFeed, ConnectionCard, EmptyState, ErrorState, LoadingSkeleton, Toast, ConfirmDialog
- [ ] 8 разделов + login + карточка компании на mock-адаптере (метка «Демо»)
- [ ] Новые экраны (пробелы дизайна): создание кампании, мастер импорта (dry-run), запись согласия, suppression, AI export/import, аудит, расходы AI, kill-switch отправки
- [ ] Убрать/оживить фейки прототипа: «Все системы в порядке», «48 из 100», счётчики навигации, Light-тег, уведомления, workspace-switch, колонка «Пилот», кнопки-тосты в Настройках
- [ ] Состояния: loading / empty / error / permission-denied / no-AI / offline
- [ ] Адаптив 360, 390, 768, 1024, 1440; клавиатура, focus, reduced-motion; axe
- [ ] Скриншоты прототипа и реализации desktop+mobile, сравнение, правки
- [ ] Отчёт фазы

## Фазы 2–6 — см. IMPLEMENTATION_PLAN §5
