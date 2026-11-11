# AutoFlow — развёртывание: сейчас на одном сервере, потом отдельно

Принцип: AutoFlow — отдельный контур внутри той же инфраструктуры. Свой домен (`AUTOFLOW_DOMAIN`), свой контейнер `autoflow-web`, свой блок Caddy, свой образ `lh-autoflow:<sha12>`. Пока `AUTOFLOW_DOMAIN` не задан, AutoFlow не собирается, не запускается и Caddy не запрашивает для него сертификат: сервер работает как раньше и не ломается до настройки DNS.

## 1. Схема «сейчас» (один сервер, 95.85.247.206)
```
Интернет → Caddy ─┬─ ai.vaylonet.ru        → web:3000 (LeadHunter), /api/* → api:8000
                  └─ autoflow.vaylonet.ru  → autoflow-web:3000,     /api/* → api:8000 (тот же API, пока)
```
- Контейнер `autoflow-web`: профиль compose `autoflow`, 192 МБ, `read_only`, `cap_drop: ALL`, `no-new-privileges`, порты не публикуются.
- Память: потолки web 384 + api 256 + db 256 + caddy 96 + autoflow-web 192 = ~1,18 ГБ из 1,9 ГБ. Сборка образов идёт на сервере поверх работающего стека (swap 3 ГБ); следите за `free -m` после включения.
- `lh-update` собирает третий образ только при включённом AutoFlow; проверка здоровья и откат охватывают все включённые образы.

## 2. Включение (владелец, ~10 минут)
1. **DNS**: A-запись `autoflow.vaylonet.ru` → `95.85.247.206` (на момент подготовки домен уже резолвился в этот IP).
2. На сервере под root: `lh-config autoflow autoflow.vaylonet.ru`. Команда пишет `AUTOFLOW_DOMAIN` в `/opt/leadhunter/.env` (атомарно, 0600) и добавляет профиль `autoflow`.
3. В течение ~3 минут `lh-update` соберёт образ, поднимет контейнер, проверит здоровье и только затем включит сайт в Caddy. Ход: `journalctl -u lh-update -n 50`; сразу: `lh-update`. Проверка: `lh-config show`, затем `https://autoflow.vaylonet.ru`.
4. Необязательно, до следующей сборки: контакты и оператор персональных данных на лендинге (по умолчанию заглушки `.example`). Добавьте в `/opt/leadhunter/.env` строки `AUTOFLOW_CONTACT_EMAIL=…`, `AUTOFLOW_CONTACT_TELEGRAM=@…`, `AUTOFLOW_OPERATOR_NAME=…` (без `$`, кавычек и пробелов по краям); они «зашиваются» в образ при сборке и применятся при следующей сборке (любой новый коммит в `main`).

Выключить: `lh-config autoflow off` (останавливает контейнер, убирает блок Caddy; LeadHunter не затрагивается). Откат версии: `lh-update --rollback` откатывает все образы вместе. Пауза обновлений: `touch /opt/leadhunter/.paused`.

Известная связь: если сборка `autoflow` не удалась, весь коммит помечается неудачным и не выкатывается (в том числе для LeadHunter). Если AutoFlow мешает, выключите его: `lh-config autoflow off`.

## 3. Приём заявок на пилот (API)
Форма отправляет `POST /api/v1/autoflow/pilot-requests` с JSON `{business_name, city, contact_name, phone|null, email|null, consent:true, website:""}`. Пока серверной части нет, ответ 404/501 и форма показывает «заявки временно не принимаются» с e-mail для связи. Серверная часть — отдельный шаг (apps/api). Учтите, что проверка Origin/CSRF в API должна разрешать `https://autoflow.vaylonet.ru`.

## 4. Перенос на отдельный сервер
Когда нагрузка или риск оправдают отдельный VPS:
1. **Подготовка нового сервера**: Ubuntu/Debian, root-доступ, Docker Engine + compose plugin, `git`, открытые порты 80/443 (и 443/udp). Скопируйте на сервер `infra/autoflow/migrate-to-server.sh` (или клонируйте репозиторий).
2. **Заранее** уменьшите TTL записи `autoflow.vaylonet.ru` до 300 с.
3. **На новом сервере** (проверьте `--dry-run`):
   ```bash
   bash migrate-to-server.sh --repo foecerip2/Test --domain autoflow.vaylonet.ru \
     --api-upstream https://ai.vaylonet.ru --contact-email you@example.com --dry-run
   # затем без --dry-run
   ```
   Скрипт клонирует репозиторий, собирает образ, кладёт в `/opt/autoflow` `docker-compose.yml` (autoflow-web + Caddy), `Caddyfile` и `.env` (`AUTOFLOW_DOMAIN`, `AUTOFLOW_API_UPSTREAM`, `AUTOFLOW_IMAGE`), запускает и ждёт здоровья. `/api/*` проксируется на `AUTOFLOW_API_UPSTREAM` (пока старый сервер).
4. **Проверка до смены DNS**: `curl --resolve autoflow.vaylonet.ru:443:<IP_нового_сервера> https://autoflow.vaylonet.ru/` (сертификат Caddy выдаст после переключения DNS).
5. **Переключение**: A-запись `autoflow.vaylonet.ru` → IP нового сервера. Когда сайт открывается с нового, на старом выполните `lh-config autoflow off`.
6. **Откат переноса**: вернуть A-запись на `95.85.247.206` и на старом `lh-config autoflow autoflow.vaylonet.ru`.
7. **Дальше**: собственный API AutoFlow и БД переезжают тем же способом (отдельный compose-сервис на новом сервере), после чего меняется `AUTOFLOW_API_UPSTREAM`. Автообновление для отдельного сервера пока не настроено: обновление — повторный запуск скрипта с новым `--ref` (позже можно подключить `lh-update` с отдельным `lh.conf`).

## 5. Переменные
| Переменная | Где | Назначение |
|---|---|---|
| `AUTOFLOW_DOMAIN` | `.env` на сервере; задаёт `lh-config autoflow` | домен AutoFlow; пусто = выключен |
| `AUTOFLOW_IMAGE` | `.env`; пишет `lh-update` | текущий образ `lh-autoflow:<sha12>` |
| `COMPOSE_PROFILES` | `.env`; пишут `lh-update`/`lh-config` | список профилей через запятую (`api,autoflow`) |
| `AUTOFLOW_CONTACT_EMAIL`, `AUTOFLOW_CONTACT_TELEGRAM`, `AUTOFLOW_OPERATOR_NAME` | `.env` (вручную) | публичные контакты и оператор ПДн, «зашиваются» при сборке |
| `NEXT_PUBLIC_API_MODE` | сборка (`mock`/`live`) | `mock` — форма без сети (для разработки: `pnpm --filter autoflow-web dev`) |
| `AUTOFLOW_API_UPSTREAM` | `.env` отдельного сервера | куда проксировать `/api/*` |
| `AUTOFLOW_URL` | переменная GitHub для APK | адрес сайта в Android-оболочке |

## 6. Что не проверено
Реальная сборка Docker-образа (в среде разработки нет демона Docker, проверена установка зависимостей и сборка Next.js; образ соберёт CI), валидация итогового Caddyfile настоящим Caddy (её делает `lh-update` на сервере до установки; при ошибке выкат отменяется), запуск на реальном сервере. Логика `lh-update`/`lh-config` проверена сценарным тестом на подставных docker/git (`infra/deploy/tests/test_lh_update.sh`), compose — командой `docker compose config`.
