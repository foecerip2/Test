# Зависимости: версии, лицензии, аудит (web, Фаза 1)

Версии зафиксированы `--save-exact` и `package-lock.json`. Версии проверены через `npm view` на 2026-11-09. Лицензии прочитаны из установленных `node_modules/*/package.json`.

| Пакет | Версия | Лицензия | Назначение |
|---|---|---|---|
| next | 16.4.5 | MIT | Фреймворк (App Router, standalone) |
| react / react-dom | 19.3.1 | MIT | UI |
| motion | 14.11.1 | MIT | Анимации (`motion/react`, LazyMotion) |
| lucide-react | 1.70.0 | ISC | Иконки |
| @radix-ui/react-dialog / dropdown-menu / tooltip / switch / tabs / checkbox | 1.3.1 / 2.2.1 / 1.4.1 / 1.4.1 / 1.2.1 / 1.4.1 | MIT | Доступные примитивы (shadcn-подход) |
| class-variance-authority | 0.7.1 | Apache-2.0 | Варианты компонентов |
| clsx, tailwind-merge | 2.1.1, 3.7.0 | MIT | Утилиты классов |
| @fontsource-variable/inter, /jetbrains-mono | 5.3.0 | OFL-1.1 | Шрифты, self-hosted (кириллица) |
| tailwindcss, @tailwindcss/postcss | 4.3.5 | MIT | Стили |
| typescript | 5.9.3 | Apache-2.0 | Типы (7.x не берём: совместимость с Next не проверена) |
| vitest | 5.1.0 | MIT | Юнит-тесты |
| @playwright/test | 1.65.0 | Apache-2.0 | E2E, скриншоты |
| @axe-core/playwright | 4.14.0 | MPL-2.0 | a11y-аудит (только dev; в бандл не попадает) |

`npm audit --omit=dev` на 2026-11-09: **0 vulnerabilities** (запускалось в сессии).

Не подключены сознательно (MD §16.5, `docs/ADR-motion.md`): GSAP, Rive, Lottie/dotLottie, Aceternity UI, Magic UI, Recharts, Storybook.

Лицензия OFL-1.1 (шрифты) разрешает коммерческое использование и встраивание; файлы шрифтов отдаются с собственного домена.

Backend-зависимости (FastAPI, SQLAlchemy, Alembic, asyncssh/OpenSSH и др.) будут зафиксированы в Фазе 2.
