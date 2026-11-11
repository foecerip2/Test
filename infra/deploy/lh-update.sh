#!/usr/bin/env bash
# LeadHunter — автообновление сервера из ветки main на GitHub (pull-модель, без секретов и без входящего SSH).
# Запускается systemd-таймером каждые ~3 минуты от root. Идемпотентен, не запускается параллельно.
#
# Логика: берём последний коммит ветки main → ждём, пока для него успешно пройдут тесты (job `test`)
# → забираем исходники этого коммита → собираем образы локально (web всегда; api — если есть apps/api/Dockerfile;
# autoflow — только если в .env задан AUTOFLOW_DOMAIN и в коммите есть apps/autoflow-web/Dockerfile)
# → запускаем → проверка здоровья web, api и autoflow-web (включённых) → при сбое откат на все прежние образа.
# Без AUTOFLOW_DOMAIN поведение прежнее: третий образ не собирается и не запускается.
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

# COMPOSE_PROFILES — список через запятую (api, autoflow); прежнее значение «api» остаётся допустимым.
has_profile() { case ",$(get_env COMPOSE_PROFILES)," in *",$1,"*) return 0 ;; esac; return 1; }
profile_add() { local cur; has_profile "$1" && return 0; cur="$(get_env COMPOSE_PROFILES)"; set_env COMPOSE_PROFILES "${cur:+$cur,}$1"; }
profile_del() {
  local out="" p arr=(); has_profile "$1" || return 0
  IFS=, read -ra arr <<<"$(get_env COMPOSE_PROFILES)"
  for p in "${arr[@]}"; do [ "$p" = "$1" ] || out="${out:+$out,}$p"; done
  set_env COMPOSE_PROFILES "$out"
}
api_enabled() { has_profile api; }
af_enabled() { has_profile autoflow; }
af_wanted() { [ -n "$(get_env AUTOFLOW_DOMAIN)" ]; }   # владелец включил AutoFlow (`lh-config autoflow DOMAIN`)

service_healthy() {   # $1 = сервис compose
  local cid st
  cid="$(compose ps -q "$1" 2>/dev/null || true)"
  [ -n "$cid" ] || return 1
  st="$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || true)"
  [ "$st" = healthy ]
}

healthy() {
  for _ in $(seq 1 "$HEALTH_TRIES"); do
    if service_healthy web && { ! api_enabled || service_healthy api; } && { ! af_enabled || service_healthy autoflow-web; }; then return 0; fi
    sleep "$HEALTH_SLEEP"
  done
  return 1
}

# switch_to WEB_IMAGE [API_IMAGE] [AUTOFLOW_IMAGE] — перезапуск стека на образах; при провале здоровья — возврат на прежние.
switch_to() {
  local web="$1" apiimg="${2:-}" afimg="${3:-}" prev_web prev_api prev_af
  prev_web="$(get_env WEB_IMAGE)"; prev_api="$(get_env API_IMAGE)"; prev_af="$(get_env AUTOFLOW_IMAGE)"
  set_env WEB_IMAGE "$web"
  [ -n "$apiimg" ] && set_env API_IMAGE "$apiimg"
  [ -n "$afimg" ] && set_env AUTOFLOW_IMAGE "$afimg"
  compose up -d --remove-orphans
  if healthy; then return 0; fi
  log "Проверка здоровья не пройдена для web=$web${apiimg:+ api=$apiimg}${afimg:+ autoflow=$afimg}"
  if { [ -n "$prev_web" ] && [ "$prev_web" != "$web" ]; } || { [ -n "$apiimg" ] && [ -n "$prev_api" ] && [ "$prev_api" != "$apiimg" ]; } \
     || { [ -n "$afimg" ] && [ -n "$prev_af" ] && [ "$prev_af" != "$afimg" ]; }; then
    [ -n "$prev_web" ] && set_env WEB_IMAGE "$prev_web"
    [ -n "$prev_api" ] && set_env API_IMAGE "$prev_api"
    [ -n "$prev_af" ] && set_env AUTOFLOW_IMAGE "$prev_af"
    compose up -d --remove-orphans
    log "Автоматический откат на web=$prev_web${prev_api:+ api=$prev_api}${prev_af:+ autoflow=$prev_af}"
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
  afimg="$(read_file .prev_good_af)"
  if [ -n "$afimg" ] && { ! af_enabled || ! docker image inspect "$afimg" >/dev/null 2>&1; }; then
    log "Образ AutoFlow $afimg недоступен или AutoFlow выключен — откат autoflow пропущен"; afimg=""
  fi
  log "Откат на web=$img${apiimg:+ api=$apiimg}${afimg:+ autoflow=$afimg} (схема БД не откатывается!)"
  if switch_to "$img" "$apiimg" "$afimg"; then
    # откатываемый коммит помечаем как отвергнутый, иначе автообновление сразу вернёт его обратно
    bad="$(read_file .last_good_sha)"; [ -n "$bad" ] && echo "$bad" > "$APP/.failed_sha"
    echo "$img" > "$APP/.last_good"
    [ -n "$apiimg" ] && echo "$apiimg" > "$APP/.last_good_api"
    [ -n "$afimg" ] && echo "$afimg" > "$APP/.last_good_af"
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

# Владелец включил AutoFlow (lh-config autoflow), а образ ещё не собран: на уже развёрнутом коммите нужен дособирающий проход
af_missing=0
if af_wanted && [ -f "$SRC/apps/autoflow-web/Dockerfile" ]; then
  af_cur="$(get_env AUTOFLOW_IMAGE)"
  { [ -n "$af_cur" ] && docker image inspect "$af_cur" >/dev/null 2>&1; } || af_missing=1
fi
[ "$(read_file .last_good_sha)" = "$sha" ] && [ "$af_missing" -eq 0 ] && exit 0   # уже развёрнут
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

# 2b. Конфигурация Caddy проверяется на временной копии ДО любой установки: ошибка в ней не должна задеть работающий сайт
CAND="$(mktemp -d)"
cp "$SRC/infra/caddy/Caddyfile" "$CAND/Caddyfile"
bh="$(get_env BASIC_HASH)"
if [ -n "$bh" ]; then cp "$SRC/infra/caddy/gate.on.caddy" "$CAND/gate.caddy"; else cp "$SRC/infra/caddy/gate.off.caddy" "$CAND/gate.caddy"; fi
# AutoFlow: на проверку идёт тот вариант, который будет установлен (on — только если домен задан и в коммите есть Dockerfile)
AF_DOMAIN="$(get_env AUTOFLOW_DOMAIN)"
AF_NOW=0; af_wanted && [ -f "$SRC/apps/autoflow-web/Dockerfile" ] && AF_NOW=1
if [ "$AF_NOW" -eq 1 ] && [ -f "$SRC/infra/caddy/autoflow.on.caddy" ]; then cp "$SRC/infra/caddy/autoflow.on.caddy" "$CAND/autoflow.caddy"
elif [ -f "$SRC/infra/caddy/autoflow.off.caddy" ]; then cp "$SRC/infra/caddy/autoflow.off.caddy" "$CAND/autoflow.caddy"
else : > "$CAND/autoflow.caddy"; fi
if ! docker run --rm -v "$CAND:/etc/caddy:ro" -e "DOMAIN=$(get_env DOMAIN)" -e "AUTOFLOW_DOMAIN=$AF_DOMAIN" -e "BASIC_USER=$(get_env BASIC_USER)" -e "BASIC_HASH=${bh//\$\$/\$}" \
     caddy:2.8-alpine caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
  log "Конфигурация Caddy из коммита ${sha:0:7} не прошла проверку — выкат отменён, продолжает работать прежняя версия"
  echo "$sha" > "$APP/.failed_sha"; rm -rf "$CAND"; exit 1
fi
rm -rf "$CAND"

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
# AutoFlow: варианты кладём всегда, а рабочий autoflow.caddy — «выключен», пока не поднят образ (см. шаг 6); так Caddyfile
# с `import autoflow.caddy` никогда не остаётся без файла.
for f in autoflow.on.caddy autoflow.off.caddy; do [ -f "$SRC/infra/caddy/$f" ] && install_caddy_file "$SRC/infra/caddy/$f" "$f"; done
[ -f "$APP/caddy/autoflow.caddy" ] || install_caddy_file "$APP/caddy/autoflow.off.caddy" autoflow.caddy
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
  profile_add api
else
  log "apps/api/Dockerfile нет — запускаются только web и caddy"
fi
# AutoFlow: третий образ только когда он включён (AUTOFLOW_DOMAIN) и есть в коммите
afimg=""
if [ "$AF_NOW" -eq 1 ]; then
  afimg="lh-autoflow:${sha:0:12}"
  log "Сборка образа $afimg (AutoFlow, домен $AF_DOMAIN)"
  af_args=(--build-arg "NEXT_PUBLIC_SITE_URL=https://$AF_DOMAIN")
  for pair in NEXT_PUBLIC_CONTACT_EMAIL:AUTOFLOW_CONTACT_EMAIL NEXT_PUBLIC_CONTACT_TELEGRAM:AUTOFLOW_CONTACT_TELEGRAM NEXT_PUBLIC_OPERATOR_NAME:AUTOFLOW_OPERATOR_NAME; do
    v="$(get_env "${pair#*:}")"; v="${v//\$\$/\$}"
    [ -n "$v" ] && af_args+=(--build-arg "${pair%%:*}=$v")
  done
  if ! docker build -t "$afimg" "${af_args[@]}" -f "$SRC/apps/autoflow-web/Dockerfile" "$SRC"; then
    log "Сборка autoflow не удалась для ${sha:0:7}"; echo "$sha" > "$APP/.failed_sha"; exit 1
  fi
  profile_add autoflow
else
  af_wanted && log "AUTOFLOW_DOMAIN задан, но apps/autoflow-web/Dockerfile в коммите нет — AutoFlow пропущен"
  profile_del autoflow
fi

# 6. Выкат и проверка здоровья
same_sha=0; [ "$(read_file .last_good_sha)" = "$sha" ] && same_sha=1   # дособирающий проход AutoFlow: «предыдущую» версию не затираем
if switch_to "$img" "$apiimg" "$afimg"; then
  if [ "$same_sha" -eq 0 ]; then
    [ -s "$APP/.last_good" ] && cp "$APP/.last_good" "$APP/.prev_good"
    [ -s "$APP/.last_good_sha" ] && cp "$APP/.last_good_sha" "$APP/.prev_good_sha"
  fi
  if [ -n "$apiimg" ]; then
    [ "$same_sha" -eq 0 ] && [ -s "$APP/.last_good_api" ] && cp "$APP/.last_good_api" "$APP/.prev_good_api"
    echo "$apiimg" > "$APP/.last_good_api"
  fi
  if [ -n "$afimg" ]; then
    [ "$same_sha" -eq 0 ] && [ -s "$APP/.last_good_af" ] && cp "$APP/.last_good_af" "$APP/.prev_good_af"
    echo "$afimg" > "$APP/.last_good_af"
  fi
  # рабочий autoflow.caddy: включаем сайт AutoFlow только когда его образ поднят и здоров
  if [ -n "$afimg" ]; then install_caddy_file "$APP/caddy/autoflow.on.caddy" autoflow.caddy; else install_caddy_file "$APP/caddy/autoflow.off.caddy" autoflow.caddy; fi
  echo "$img" > "$APP/.last_good"; echo "$sha" > "$APP/.last_good_sha"; rm -f "$APP/.failed_sha"
  log "Готово: работает коммит ${sha:0:7}"
  [ "$CADDY_CHANGED" -eq 1 ] && { compose restart caddy >/dev/null 2>&1 || log "Не удалось перезапустить caddy (конфигурация применится при следующем запуске)"; }
  # чистка: оставляем 3 последних образа каждого репозитория и ограничиваем кэш сборки
  for repo in lh-web lh-api lh-autoflow; do
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
