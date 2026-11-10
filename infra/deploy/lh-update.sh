#!/usr/bin/env bash
# LeadHunter — автообновление сервера из ветки main на GitHub (pull-модель, без секретов и без входящего SSH).
# Запускается systemd-таймером каждые ~3 минуты от root. Идемпотентен, не запускается параллельно.
#
# Логика: берём последний коммит ветки main → ждём, пока для него успешно пройдут тесты (job `test`)
# → забираем исходники этого коммита → собираем образы локально (web всегда; api — если есть apps/api/Dockerfile)
# → запускаем → проверка здоровья web И api → при сбое откат на оба прежних образа.
# «Одобрение» — в чате с разработчиком: в main код попадает только после вашего разрешения.
#
# ВАЖНО про БД: контейнер api сам выполняет `alembic upgrade head` при старте. Откат образа НЕ откатывает схему БД,
# поэтому миграции обязаны быть обратно совместимыми (см. docs/OPERATIONS.md).
#
#   lh-update             — проверить и обновиться при необходимости
#   lh-update --rollback  — вернуться на предыдущую рабочую версию (откатываемый коммит больше не разворачивается)
#   touch /opt/leadhunter/.paused  — приостановить автообновление (rm — возобновить)
set -euo pipefail

APP="${LH_APP:-/opt/leadhunter}"
SELF="${LH_SELF:-/usr/local/sbin/lh-update}"
CONFIG_BIN="${LH_CONFIG_BIN:-/usr/local/sbin/lh-config}"
# shellcheck disable=SC1091
. "$APP/lh.conf"                        # REPO=owner/name [BRANCH=main]
BRANCH="${BRANCH:-main}"
API="${LH_API:-https://api.github.com}"
GIT_URL="${LH_GIT_URL:-https://github.com/$REPO.git}"
SRC="$APP/src"
HEALTH_TRIES="${LH_HEALTH_TRIES:-60}"
HEALTH_SLEEP="${LH_HEALTH_SLEEP:-3}"

exec 9>"$APP/.update.lock"
flock -n 9 || exit 0

log() { logger -t lh-update -- "$*" 2>/dev/null || true; printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
api() { curl -fsS --max-time 20 -H "Accept: application/vnd.github+json" "$API/$1"; }
compose() { docker compose --env-file "$APP/.env" -f "$APP/docker-compose.prod.yml" "$@"; }
get_env() { grep -E "^$1=" "$APP/.env" | head -1 | cut -d= -f2- || true; }
set_env() { if grep -qE "^$1=" "$APP/.env"; then sed -i "s|^$1=.*|$1=$2|" "$APP/.env"; else echo "$1=$2" >> "$APP/.env"; fi; }
read_file() { cat "$APP/$1" 2>/dev/null || true; }

api_enabled() { [ "$(get_env COMPOSE_PROFILES)" = "api" ]; }

service_healthy() {   # $1 = сервис compose
  local cid st
  cid="$(compose ps -q "$1" 2>/dev/null || true)"
  [ -n "$cid" ] || return 1
  st="$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || true)"
  [ "$st" = healthy ]
}

healthy() {
  for _ in $(seq 1 "$HEALTH_TRIES"); do
    if service_healthy web && { ! api_enabled || service_healthy api; }; then return 0; fi
    sleep "$HEALTH_SLEEP"
  done
  return 1
}

# switch_to WEB_IMAGE [API_IMAGE] — перезапуск стека на образах; при провале здоровья — возврат на прежние оба.
switch_to() {
  local web="$1" apiimg="${2:-}" prev_web prev_api
  prev_web="$(get_env WEB_IMAGE)"; prev_api="$(get_env API_IMAGE)"
  set_env WEB_IMAGE "$web"
  [ -n "$apiimg" ] && set_env API_IMAGE "$apiimg"
  compose up -d --remove-orphans
  if healthy; then return 0; fi
  log "Проверка здоровья не пройдена для web=$web${apiimg:+ api=$apiimg}"
  if { [ -n "$prev_web" ] && [ "$prev_web" != "$web" ]; } || { [ -n "$apiimg" ] && [ -n "$prev_api" ] && [ "$prev_api" != "$apiimg" ]; }; then
    [ -n "$prev_web" ] && set_env WEB_IMAGE "$prev_web"
    [ -n "$prev_api" ] && set_env API_IMAGE "$prev_api"
    compose up -d --remove-orphans
    log "Автоматический откат на web=$prev_web${prev_api:+ api=$prev_api}"
  fi
  return 1
}

if [ "${1:-}" = "--rollback" ]; then
  img="$(read_file .prev_good)"
  apiimg="$(read_file .prev_good_api)"
  [ -n "$img" ] || { log "Нет предыдущей рабочей версии"; exit 4; }
  docker image inspect "$img" >/dev/null 2>&1 || { log "Образ $img уже удалён"; exit 4; }
  if [ -n "$apiimg" ] && ! docker image inspect "$apiimg" >/dev/null 2>&1; then
    log "Образ $apiimg уже удалён — откат api пропущен, откатывается только web"; apiimg=""
  fi
  log "Откат на web=$img${apiimg:+ api=$apiimg} (схема БД не откатывается!)"
  if switch_to "$img" "$apiimg"; then
    # откатываемый коммит помечаем как отвергнутый, иначе автообновление сразу вернёт его обратно
    bad="$(read_file .last_good_sha)"; [ -n "$bad" ] && echo "$bad" > "$APP/.failed_sha"
    echo "$img" > "$APP/.last_good"
    [ -n "$apiimg" ] && echo "$apiimg" > "$APP/.last_good_api"
    [ -s "$APP/.prev_good_sha" ] && cp "$APP/.prev_good_sha" "$APP/.last_good_sha"
    log "Откат выполнен. Автообновление продолжится со следующего нового коммита в $BRANCH"
  fi
  exit 0
fi

[ -f "$APP/.paused" ] && { log "Автообновление на паузе (файл .paused)"; exit 0; }

# 1. Последний коммит ветки
head="$(api "repos/$REPO/commits/$BRANCH")" || { log "GitHub недоступен: пропуск"; exit 0; }
sha="$(jq -r '.sha // empty' <<<"$head")"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { log "Не удалось определить коммит ветки $BRANCH: пропуск"; exit 0; }

[ "$(read_file .last_good_sha)" = "$sha" ] && exit 0                 # уже развёрнут
[ "$(read_file .failed_sha)" = "$sha" ] && exit 0                    # эту версию уже пробовали/откатили

# 2. Тесты для этого коммита должны пройти (если ещё идут — подождём следующего запуска)
cr="$(api "repos/$REPO/commits/$sha/check-runs?per_page=100")" || { log "Не удалось проверить CI: пропуск"; exit 0; }
ok="$(jq -r '[.check_runs[]? | select(.name=="test" and .conclusion=="success")] | length' <<<"$cr")"
if [ "${ok:-0}" -lt 1 ]; then
  state="$(jq -r '[.check_runs[]? | select(.name=="test")] | map(.status + ":" + (.conclusion // "")) | first // "нет"' <<<"$cr")"
  log "Коммит ${sha:0:7}: тесты не пройдены или ещё идут (test = $state) — пропуск"
  exit 0
fi

log "Новый коммит ${sha:0:7} в $BRANCH, тесты прошли: загрузка исходников"
[ -d "$SRC/.git" ] || git clone --no-checkout --filter=blob:none "$GIT_URL" "$SRC"
git -C "$SRC" fetch --depth=1 origin "$sha"
git -C "$SRC" checkout --force --detach "$sha"
[ "$(git -C "$SRC" rev-parse HEAD)" = "$sha" ] || { log "SHA после загрузки не совпал — отмена"; exit 1; }

# 3. Конфигурация из коммита: compose и Caddy (Caddyfile + gate.caddy по наличию BASIC_HASH)
install -m 0644 "$SRC/infra/compose/docker-compose.prod.yml" "$APP/docker-compose.prod.yml.new" && mv -f "$APP/docker-compose.prod.yml.new" "$APP/docker-compose.prod.yml"
install -d -m 0755 "$APP/caddy"
CADDY_CHANGED=0
install_caddy_file() {   # $1 = источник, $2 = имя в $APP/caddy
  if ! cmp -s "$1" "$APP/caddy/$2"; then
    install -m 0644 "$1" "$APP/caddy/$2.new" && mv -f "$APP/caddy/$2.new" "$APP/caddy/$2"; CADDY_CHANGED=1
  fi
}
install_caddy_file "$SRC/infra/caddy/Caddyfile" Caddyfile
install_caddy_file "$SRC/infra/caddy/gate.on.caddy" gate.on.caddy
install_caddy_file "$SRC/infra/caddy/gate.off.caddy" gate.off.caddy
if [ -n "$(get_env BASIC_HASH)" ]; then gate=gate.on.caddy; else gate=gate.off.caddy; fi
install_caddy_file "$APP/caddy/$gate" gate.caddy
rm -f "$APP/Caddyfile"   # старое расположение (до ADR-015)

# 4. Нужен ли api в этом коммите?
API_NOW=0; [ -f "$SRC/apps/api/Dockerfile" ] && API_NOW=1
if [ "$API_NOW" -eq 1 ]; then
  need=0; for k in POSTGRES_PASSWORD SECRET_KEY DATABASE_URL PUBLIC_ORIGIN; do [ -n "$(get_env "$k")" ] || need=1; done
  if [ "$need" -eq 1 ]; then
    log "В .env нет секретов для api — генерирую недостающие (lh-config init)"
    LH_APP="$APP" bash "$SRC/infra/deploy/lh-config.sh" init || { log "lh-config init не удался"; echo "$sha" > "$APP/.failed_sha"; exit 1; }
  fi
fi

# 5. Сборка образов (последовательно: на 1.9 ГБ RAM параллельно нельзя)
img="lh-web:${sha:0:12}"
log "Сборка образа $img"
if ! docker build -t "$img" -f "$SRC/apps/web/Dockerfile" "$SRC"; then
  log "Сборка web не удалась для ${sha:0:7}"; echo "$sha" > "$APP/.failed_sha"; exit 1
fi
apiimg=""
if [ "$API_NOW" -eq 1 ]; then
  apiimg="lh-api:${sha:0:12}"
  log "Сборка образа $apiimg"
  if ! docker build -t "$apiimg" -f "$SRC/apps/api/Dockerfile" "$SRC/apps/api"; then
    log "Сборка api не удалась для ${sha:0:7}"; echo "$sha" > "$APP/.failed_sha"; exit 1
  fi
  set_env COMPOSE_PROFILES api
else
  log "apps/api/Dockerfile нет — запускаются только web и caddy"
fi

# 6. Выкат и проверка здоровья
if switch_to "$img" "$apiimg"; then
  [ -s "$APP/.last_good" ] && cp "$APP/.last_good" "$APP/.prev_good"
  [ -s "$APP/.last_good_sha" ] && cp "$APP/.last_good_sha" "$APP/.prev_good_sha"
  if [ -n "$apiimg" ]; then
    [ -s "$APP/.last_good_api" ] && cp "$APP/.last_good_api" "$APP/.prev_good_api"
    echo "$apiimg" > "$APP/.last_good_api"
  fi
  echo "$img" > "$APP/.last_good"; echo "$sha" > "$APP/.last_good_sha"; rm -f "$APP/.failed_sha"
  log "Готово: работает коммит ${sha:0:7}"
  [ "$CADDY_CHANGED" -eq 1 ] && { compose restart caddy >/dev/null 2>&1 || log "Не удалось перезапустить caddy (конфигурация применится при следующем запуске)"; }
  # чистка: оставляем 3 последних образа каждого репозитория и ограничиваем кэш сборки
  for repo in lh-web lh-api; do
    docker image ls "$repo" --format '{{.Repository}}:{{.Tag}}' | tail -n +4 | xargs -r docker rmi >/dev/null 2>&1 || true
  done
  docker builder prune -f --keep-storage 2GB >/dev/null 2>&1 || true
  # самообновление скрипта и lh-config из того же коммита (атомарно, текущий процесс не затрагивается)
  if [ -f "$SRC/infra/deploy/lh-config.sh" ] && ! cmp -s "$SRC/infra/deploy/lh-config.sh" "$CONFIG_BIN"; then
    install -m 0755 "$SRC/infra/deploy/lh-config.sh" "$CONFIG_BIN.new" && mv -f "$CONFIG_BIN.new" "$CONFIG_BIN"
  fi
  if [ -f "$SRC/infra/deploy/lh-update.sh" ] && ! cmp -s "$SRC/infra/deploy/lh-update.sh" "$SELF"; then
    install -m 0755 "$SRC/infra/deploy/lh-update.sh" "$SELF.new" && mv -f "$SELF.new" "$SELF"
  fi
else
  echo "$sha" > "$APP/.failed_sha"
  exit 1
fi
