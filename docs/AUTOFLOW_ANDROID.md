# Android-приложение AutoFlow

Приложение (`apps/autoflow-android`, Capacitor) — тонкая оболочка: открывает `https://autoflow.vaylonet.ru`. Интерфейс и логика живут на сайте, поэтому обновление сайта сразу видно в приложении (ADR-013). Пакет `ai.vaylonet.autoflow`, название «AutoFlow», Android 7.0+ (API 24). Это **отдельное** приложение: LeadHunter (`apps/android`, `ai.vaylonet.leadhunter`) устанавливается независимо.

## Чем отличается от LeadHunter
- Свой `appId`, имя, иконка (adaptive icon: знак «слоты расписания и галочка» на оранжевом фоне, векторный foreground + PNG для Android 7), экран загрузки.
- Адрес сайта берётся из конфигурации: `AUTOFLOW_URL` (по умолчанию `https://autoflow.vaylonet.ru`), см. `apps/autoflow-android/capacitor.config.js`. Навигация разрешена только на домен этого адреса; только `https`.
- Нет диалога basic-auth (он нужен только LeadHunter): `MainActivity` пустая, лендинг публичный.
- Нет соединения → локальная страница «Не удаётся подключиться» с кнопкой «Повторить» (адрес берёт из `www/config.js`, который пишет `pnpm --filter autoflow-android sync`).
- Резервное копирование данных приложения отключено; нативных API для удалённого содержимого нет, кроме интернета.

## Сборка
- GitHub: Actions → «AutoFlow Android APK» → Run workflow (или автоматически при изменениях в `apps/autoflow-android/**` в `main`). APK появляется в Releases с тегом `autoflow-android-N`. Другой адрес сайта: переменная репозитория `AUTOFLOW_URL` (Settings → Variables).
- Локально: `pnpm install && AUTOFLOW_URL=https://… pnpm --filter autoflow-android sync && cd apps/autoflow-android/android && ./gradlew assembleRelease` (JDK 21, Android SDK 36). Для подписи: `AF_KEYSTORE`, `AF_KS_PASS` (alias `autoflow`).
- Workflow `android.yml` (LeadHunter) не менялся; при изменениях только в `apps/autoflow-android/**` он не запускается.

## Установка
1. Скачайте `AutoFlow.apk` (GitHub → Releases → `autoflow-android-N`).
2. Откройте файл и разрешите установку из этого источника.

## Ограничения
- Ключ подписи временный: каждая сборка подписана новым ключом, новый APK нельзя поставить поверх старого — сначала удалите приложение. Стабильный ключ нужен для RuStore/Google Play.
- **Сборка APK и запуск на телефоне в среде разработки не проверялись** (нет Android SDK). Проверены: `cap sync` (конфигурация, копирование `www`), согласованность идентификаторов, ресурсы иконок. Первая настоящая сборка пройдёт в GitHub Actions.
- До появления кабинета автосервиса приложение показывает лендинг; вход, push-уведомления и расписание — следующие этапы (`docs/AUTOFLOW.md`).
- iOS не делается (ADR-013).
