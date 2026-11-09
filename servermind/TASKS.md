# TASKS

Статусы: ✅ сделано и проверено · 🟡 частично · ⬜ не начато. «Проверено» = запускалось в сессии (команды ниже).

## Фаза 0 — Preflight и ADR
- ✅ ADR 0001, ARCHITECTURE, SECURITY, IMPLEMENTATION_PLAN, .env.example, DESIGN_SYSTEM, threat-model, список зависимостей с лицензиями
- 🟡 Preflight: выполнен только в песочнице сессии (Ubuntu 24.04, 4 vCPU/16 ГБ, Docker-демона нет). Целевого VPS нет, замеры RAM/диска на 1–2 vCPU/4 ГБ **не проводились**

## Фаза 1 — UI и дизайн-система (web)
- ✅ Токены V2, AppShell, SideNav, bottom nav + drawer, PageHeader, Stat/Server/Operation карточки, UsageMeter, график (SVG), ActionPlanCard, RiskBanner, ConfirmActionDialog (bottom sheet на mobile), EventLog, ExecutionProgress, SecretInput, Empty/Error/Skeleton, toast
- ✅ 15 маршрутов (`npm run build`: 15 страниц)
- ✅ Dev-фикстуры изолированы; в production-бандле 0 вхождений (grep по `.next`)
- ✅ Проверки (фактически запускались): `tsc --noEmit` ok · vitest 42/42 · Playwright fixtures 122/122 (107 экран×ширина 320–1440 без overflow и ошибок консоли + axe serious/critical на 15 экранах × 1440/390, сценарии, скриншоты) · Playwright production 14/14
- ✅ Скриншоты: `docs/design/screenshots/` (38 файлов, на всех ribbon «Демо-данные»)
- 🟡 Сверка с PNG V2 — визуальная, не попиксельная; светлой темы нет (намеренно)
- 🟡 Не проверялись: реальные устройства/Android, Lighthouse/CLS, размер бандла, брауз. кроме Chromium
- ⬜ CI-воркфлоу (`.github/workflows/`) — пока пусто

## Известные ограничения Фазы 1
- Фикстуры — в памяти страницы: полная перезагрузка сбрасывает состояние
- Одинаковые запросы (серверы/операции) дублируются между компонентами — добавить общий кэш при подключении API
- Канонизация хеша плана сделана на клиенте; контракт должен совпасть с серверным (предложение: RFC 8785 JCS) — иначе подтверждение будет блокироваться
- `next start` с `output: standalone` даёт предупреждение; в проде запускать `node .next/standalone/server.js`
- Playwright использует предустановленный Chromium через `executablePath` (версии не совпадают); в CI — `playwright install chromium`

## Следующее
- ⬜ Фаза 2: FastAPI, PostgreSQL+Alembic, сессии/2FA/CSRF, tenant-check, SSH host-key pinning, read-only метрики, SSRF-политика, шифрование секретов. **Gate:** подключение реального VPS (нужно разрешение владельца и тестовый VPS)
- ⬜ Фазы 3–5 по `IMPLEMENTATION_PLAN.md`
