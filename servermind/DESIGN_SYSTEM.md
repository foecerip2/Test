# DESIGN SYSTEM V2 (реализация)

Источник: MD §16 и `SERVERMIND_DESIGN_V2.png` (композиция, не данные). Токены — только `apps/web/styles/tokens.css`; компоненты не содержат hex-цветов.

## Токены
Цвета V2 (canvas, sidebar, surface, elevated, hover, stroke, primary, info, ai, success, warning, danger, text×3, focus) + одно отступление: `--color-danger-fg: #fca5a5` для текста на красном тинте (axe требует контраст AA; базовый `#ef4444` не проходил). Радиусы 10/14/18. Шрифты: Inter Variable (кириллица) и JetBrains Mono Variable, self-hosted. Размеры: H1 30/38, H2 22/30, H3 17/24, тело 14/22, KPI 26/32 tabular.

## Layout
Sidebar 240px, topbar 64px, контент до 1480px, отступы 4/8/12/16/20/24/32. Mobile: drawer + нижняя навигация (Обзор / Серверы / AI / Ещё); на `/assistant` и экране подтверждения нижняя навигация скрыта (фокус-режим), меню доступно через гамбургер.

## Компоненты (§16.2)
Реализованы: AppShell, SideNav, MobileBottomNav, PageHeader, WorkspaceSwitch, StatCard, ServerCard, UsageMeter, MetricSparkline/MetricChart, StatusBadge, ServerPicker, AgentStepTimeline, ActionPlanCard, RiskBanner, ConfirmActionDialog, ExecutionProgress, EventLog, SecretInput, EmptyState, ErrorState, SkeletonBlock, Toast, KeyboardShortcutHint, BYOK-карточки, Stepper/DeployWizard (внутри `deploy-view`), composer (внутри `assistant-view`).

## Motion
CSS-transitions + `motion/react` (LazyMotion). 100–260 мс, opacity/transform, stagger ≤40 мс и ≤5, `prefers-reduced-motion` отключает движение (проверено e2e). Пульс статуса — только при `checking`. Прогресс — только из `stepsDone/stepsTotal`. Библиотеки Rive/Lottie/GSAP/Aceternity/Magic UI не подключены (`docs/ADR-motion.md`).

## Правила честности
Нет данных → «нет данных»/«Недостаточно данных»; офлайн → «Сервер недоступен — последняя успешная проверка: HH:MM UTC»; цены моделей не показываются; «Пополнить» отключена; демо-данные помечены.

## Справочные ссылки (не зависимости)
Motion — https://motion.dev/docs/react · shadcn/ui — https://ui.shadcn.com/docs · Radix — https://www.radix-ui.com/primitives · Lucide — https://lucide.dev · Rive, Lottie, Magic UI, Aceternity — только вдохновение, лицензии не проверялись.
