# Развёртывание ServerMind на VPS (автоустановка и автообновление)

> Статус проверки: логика установщика/обновлятора проверена на поддельном docker; **реальный запуск на VPS ещё не выполнялся** — см. «Что не проверено» внизу. Архитектура и компромиссы — [ADR 0003](../decisions/0003-auto-deploy.md).

## Как это работает
```
git push → GitHub Actions: тесты → образы в GHCR (sha-<commit>) → [одобрение] → тег stable
                                                                              │ (VPS опрашивает раз в минуту)
VPS: servermind-update.timer → новый digest? → бэкап БД → миграции → запуск по digest → smoke → успех / откат
```
В GitHub **нет** ни SSH-ключа, ни доступа к вашему серверу.

## 1. Подготовка в GitHub (один раз)
1. Убедитесь, что workflow `.github/workflows/servermind.yml` включён (Actions → servermind) и первый запуск на `main` прошёл: должны появиться пакеты `servermind-api` и `servermind-web` (Packages) с тегом `stable`.
2. **Доступ VPS к образам.** Если пакеты публичные — ничего не нужно. Если приватные (по умолчанию у новых пакетов) — создайте token (classic) со scope `read:packages`, сохраните в файл на VPS (`chmod 600`) и передайте установщику `--ghcr-user … --ghcr-token-file …`.
3. **Защита выката (рекомендуется):** Settings → Environments → `production` → *Required reviewers* (вы). Тогда `stable` сдвинется — и VPS обновится — только после вашего Approve. Settings → Branches → защита `main` (обязательные проверки CI, запрет прямого push).
4. Если проект вынесен в отдельный репозиторий (`servermind/` в корне) — уберите префикс `servermind/` в путях workflow.

## 2. Установка на VPS — быстрый путь
Репозиторий публичный, значения по умолчанию заданы в установщике (`ghcr.io/foecerip2/servermind`), память определяется автоматически (при 1,7–3,4 ГБ RAM включаются `--low-memory` и swap 2 ГБ — это видно в плане, подтверждение `y` обязательно):
```bash
curl -fsSL -o install.sh https://raw.githubusercontent.com/foecerip2/Test/main/servermind/bootstrap/install.sh
sudo bash install.sh --domain ai.vaylonet.ru --create-owner you@example.com
```
Если образ приватный, установщик сам спросит GitHub token (scope `read:packages`) вместо падения. Чтобы токен не был нужен вообще: GitHub → Packages → `servermind-api` и `servermind-web` → Package settings → Change visibility → Public (один раз; через CI это сделать нельзя).

## 2a. Установка на VPS — подробно
Подключитесь к **чистому** Ubuntu 24.04 (1–2 vCPU / 4 ГБ / ≥ 8 ГБ свободно). Скачайте установщик, **прочитайте его**, посмотрите план и только потом запускайте:
```bash
curl -fsSL -o install.sh https://raw.githubusercontent.com/<owner>/<repo>/main/servermind/bootstrap/install.sh
less install.sh
sudo bash install.sh --image-repo ghcr.io/<owner>/servermind --dry-run      # план, ничего не меняет
sudo bash install.sh --image-repo ghcr.io/<owner>/servermind --domain app.example.com --create-owner you@example.com
```
- `--low-memory` — **облегчённый режим для VPS с ≈2 ГБ RAM (тест)**: лимиты контейнеров PostgreSQL 320m / API 256m / web 224m / Caddy 48m, `shared_buffers=64MB`, `max_connections=30`, `--max-old-space-size=160` для Node. Порог RAM снижается до ≈1,7 ГБ. **Работа на 2 ГБ не измерялась**: запас мал, возможны OOM-перезапуски контейнеров (смотрите `docker compose … ps`, `dmesg | grep -i oom`). Для продакшена — 4 ГБ и обычный режим. После увеличения RAM: удалите строки `SM_*` из `/opt/servermind/compose/.env` и выполните `docker compose -p servermind --project-directory /opt/servermind/compose up -d`.
- `--swap-size 2048` — создать swap-файл `/swapfile` (только по этому флагу; если swap уже есть или файл существует — не трогается; запись в `/etc/fstab`). Swap замедляет работу при нехватке RAM, но защищает от OOM.
- `--domain` — автоматический HTTPS (нужна A-запись и свободные порты 80/443). Без домена — HTTP на `:80` **только для теста** (cookie без Secure).
- Занят порт 80/443 чужой службой (nginx/caddy) → установщик **откажет и ничего не остановит**: освободите порт сами либо используйте другой порт/сервер.
- Пароль владельца вводится интерактивно; пароль root серверу не нужен нигде.
- После установки: сохраните копию `/opt/servermind/env/api.env` (мастер-ключ шифрования) **вне сервера** и настройте вынос бэкапов `/opt/servermind/backups`.

## 3. Что лежит на сервере
```
/opt/servermind/
  env/        postgres.env, api.env      — секреты (600), в git и образах их нет
  compose/    docker-compose.yml, Caddyfile, .env (digest образов, порты, домен)
  state/      config, deployed.env, failed.env, last-update.json, previous/
  backups/    db-<UTC>.dump (последние 5, права 600)
  bin/        update.sh
/etc/systemd/system/servermind-update.{service,timer}
```

## 4. Повседневное
| Действие | Команда |
|---|---|
| Статус последнего обновления | `journalctl -u servermind-update -n 50` · `systemctl list-timers servermind-update.timer` · `cat /opt/servermind/state/last-update.json` (файл появляется только после первого фактического обновления или сбоя) |
| Какая версия запущена | `cat /opt/servermind/state/deployed.env` |
| Приостановить автообновление | `touch /opt/servermind/state/auto-update.disabled` (возобновить — удалить файл) |
| Не обновлять во время работ | `touch /opt/servermind/state/maintenance.lock` |
| Обновить сейчас | `sudo systemctl start servermind-update.service` |
| Логи сервисов | `docker compose -p servermind --project-directory /opt/servermind/compose logs -f --tail 100` |

Значения `result` в `last-update.json`: `ok`, `rolled_back` (новая версия не прошла проверку, возвращена прежняя), `rollback_failed` (**нужно ручное вмешательство**), `migration_failed`, `backup_failed`, `bad_compose`, `bad_bundle`, `skipped_disk` (< 3 ГБ свободно).

## 5. Откат и восстановление
- Автоматически: при сбое smoke-тестов возвращаются прежние образы и конфигурация; сломанный релиз пропускается, пока не выйдет новый.
- Вручную назад на конкретный релиз: поставьте паузу, в `/opt/servermind/compose/.env` укажите нужные `SERVERMIND_API_IMAGE` / `SERVERMIND_WEB_IMAGE` (digest из `deployed.env` или GHCR), `docker compose … up -d`.
- **Схема БД не откатывается вместе с образами.** Восстановление данных: `pg_restore` из `/opt/servermind/backups/db-*.dump` (остановите `api` на время восстановления).

## 6. Безопасность
- Выкат кода = право записи в `main` + одобрение `production`. Защитите их.
- Обновлятор работает от root (доступ к Docker). Тянет только `<image-repo>-api:stable` и веб-образ по digest из `release.json`.
- Docker публикует порты контейнеров в обход `ufw`; наружу публикуются только порты Caddy. PostgreSQL и API портов не публикуют; сеть БД — `internal`.
- Исходящий доступ с VPS нужен: GHCR, Let's Encrypt (при домене), провайдеры AI, SSH к подключаемым серверам.

## 7. Удаление
`sudo systemctl disable --now servermind-update.timer && sudo rm /etc/systemd/system/servermind-update.* && docker compose -p servermind --project-directory /opt/servermind/compose down` (тома с данными сохраняются; `down -v` и удаление `/opt/servermind` удаляют данные — сначала бэкап).

## Что не проверено
Сборка Dockerfile (первая проверка — job `images` в CI), `docker compose up`, реальный HTTPS/ACME, pull из GHCR, systemd-таймер на живой системе, установка Docker через apt, работа на Python 3.12 (CI использует 3.12; локально тесты шли на 3.13), права `cap_drop` для API/web (PostgreSQL запускается без `cap_drop` намеренно). Рекомендуется первый запуск на **отдельном тестовом VPS** с `--dry-run`, затем боевой.
