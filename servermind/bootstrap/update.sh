#!/usr/bin/env bash
# ServerMind auto-updater. Запускается systemd-таймером (раз в минуту) на VPS.
#
# Идея: CI собирает образы и двигает тег `stable` у API-образа; VPS сам (pull) замечает новый digest и обновляется:
#   бэкап БД -> миграции -> запуск новых образов по digest -> smoke-тесты -> при сбое откат и запрет повторять сломанный релиз.
# GitHub не имеет доступа к серверу (никаких SSH-ключей в секретах).
#
# Управление:
#   touch /opt/servermind/state/auto-update.disabled   — приостановить автообновление
#   touch /opt/servermind/state/maintenance.lock       — не обновлять во время обслуживания/операций
set -Eeuo pipefail

SM_ROOT="${SM_ROOT:-/opt/servermind}"
DOCKER="${DOCKER:-docker}"
STATE="$SM_ROOT/state"
COMPOSE_DIR="$SM_ROOT/compose"
BACKUPS="$SM_ROOT/backups"
BIN_DIR="$SM_ROOT/bin"
KEEP_BACKUPS="${KEEP_BACKUPS:-5}"
DISK_MIN_FREE_MB="${DISK_MIN_FREE_MB:-3072}"
SMOKE_TIMEOUT="${SMOKE_TIMEOUT:-90}"
SMOKE_INTERVAL="${SMOKE_INTERVAL:-3}"
SM_NO_SYSLOG="${SM_NO_SYSLOG:-0}"

ulog() {
  printf '%s update: %s\n' "$(date -u +%FT%TZ)" "$*"
  if [[ "$SM_NO_SYSLOG" != "1" ]] && command -v logger >/dev/null 2>&1; then logger -t servermind-update -- "$*" || true; fi
}

# Статус последней попытки — для людей и для будущей страницы админки. Сообщение очищается от кавычек.
write_status() {
  local result="$1" msg="${2:-}"
  msg="${msg//\"/\'}"; msg="${msg//$'\n'/ }"
  printf '{"at":"%s","result":"%s","message":"%s","api":"%s","commit":"%s"}\n' \
    "$(date -u +%FT%TZ)" "$result" "$msg" "${CANDIDATE_API:-}" "${CANDIDATE_COMMIT:-}" > "$STATE/last-update.json.tmp"
  mv -f "$STATE/last-update.json.tmp" "$STATE/last-update.json"
}

dc() {
  "$DOCKER" compose --project-name servermind --project-directory "$COMPOSE_DIR" \
    --env-file "$COMPOSE_DIR/.env" -f "$COMPOSE_DIR/docker-compose.yml" "$@"
}

env_get() { sed -n "s/^$2=//p" "$1" 2>/dev/null | tail -n 1; }

env_set() { # env_set FILE KEY VALUE (атомарно)
  local f="$1" k="$2" v="$3" tmp
  tmp="$(mktemp "$f.XXXXXX")"
  { grep -v "^$k=" "$f" 2>/dev/null || true; printf '%s=%s\n' "$k" "$v"; } > "$tmp"
  chmod 600 "$tmp"; mv -f "$tmp" "$f"
}

free_mb() { df -Pm "$SM_ROOT" | awk 'NR==2 {print $4}'; }

container_matches_image() {
  local service="$1" expected="$2" cid image_id
  cid="$(dc ps -q "$service" 2>/dev/null)" || return 1
  [[ -n "$cid" && -n "$expected" ]] || return 1
  image_id="$("$DOCKER" image inspect --format '{{.Id}}' "$expected" 2>/dev/null)" || return 1
  [[ -n "$image_id" ]] && [[ "$("$DOCKER" inspect -f '{{.Image}} {{.State.Running}}' "$cid" 2>/dev/null)" == "$image_id true" ]]
}

# Проверяем образы до HTTP-запросов: прежние контейнеры тоже могут успешно отвечать.
smoke_ok() {
  container_matches_image api "$1" && container_matches_image web "$2" || return 1
  dc exec -T api python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/readyz',timeout=3).status==200 else 1)" >/dev/null 2>&1 || return 1
  dc exec -T web node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1 || return 1
  local cid
  cid="$(dc ps -q caddy 2>/dev/null | head -n 1)"
  [[ -n "$cid" ]] && [[ "$("$DOCKER" inspect -f '{{.State.Running}}' "$cid" 2>/dev/null)" == "true" ]]
}

wait_smoke() {
  local expected_api expected_web waited=0
  expected_api="${1:-$(env_get "$COMPOSE_DIR/.env" SERVERMIND_API_IMAGE)}"
  expected_web="${2:-$(env_get "$COMPOSE_DIR/.env" SERVERMIND_WEB_IMAGE)}"
  while (( waited < SMOKE_TIMEOUT )); do
    smoke_ok "$expected_api" "$expected_web" && return 0
    sleep "$SMOKE_INTERVAL"; waited=$((waited + SMOKE_INTERVAL))
  done
  return 1
}

prune_backups() {
  # shellcheck disable=SC2012
  ls -1t "$BACKUPS"/db-*.dump 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | while read -r old; do rm -f -- "$old"; done
}

backup_db() {
  mkdir -p "$BACKUPS"; chmod 700 "$BACKUPS"
  local out ts
  ts="$(date -u +%Y%m%dT%H%M%SZ)"; out="$BACKUPS/db-$ts.dump"
  if ! dc exec -T postgres pg_dump -U servermind -Fc servermind > "$out" 2>/dev/null || [[ ! -s "$out" ]]; then
    rm -f -- "$out"; return 1
  fi
  chmod 600 "$out"
  dc exec -T postgres pg_restore -l < "$out" >/dev/null 2>&1 || { rm -f -- "$out"; return 1; }  # дамп должен читаться
  BACKUP_FILE="$out"
}

restore_previous_files() {
  cp -f "$STATE/previous/docker-compose.yml" "$COMPOSE_DIR/docker-compose.yml" &&
    cp -f "$STATE/previous/Caddyfile" "$COMPOSE_DIR/Caddyfile" &&
    cp -f "$STATE/previous/.env" "$COMPOSE_DIR/.env"
}

fail_release() { # fail_release RESULT MESSAGE — запомнить сломанный digest, чтобы не уйти в цикл повторов
  env_set "$STATE/failed.env" FAILED_API "$CANDIDATE_API"
  ulog "ОШИБКА: $2"
  write_status "$1" "$2"
}

rollback() {
  ulog "откат на предыдущий релиз"
  local previous_api previous_web
  previous_api="$(env_get "$STATE/previous/.env" SERVERMIND_API_IMAGE)"
  previous_web="$(env_get "$STATE/previous/.env" SERVERMIND_WEB_IMAGE)"
  if restore_previous_files && dc up -d --remove-orphans >/dev/null && wait_smoke "$previous_api" "$previous_web"; then
    write_status "rolled_back" "$1 Выполнен откат на предыдущий релиз; сломанный релиз пропускается."
    ulog "откат выполнен успешно"
    return 0
  fi
  write_status "rollback_failed" "$1 Откат НЕ удался — требуется ручное вмешательство."
  ulog "КРИТИЧНО: откат не удался"
  return 1
}

update_main() {
  mkdir -p "$STATE" "$COMPOSE_DIR" "$SM_ROOT/bin"
  exec 9> "$STATE/update.lock"
  command -v "${FLOCK:-flock}" >/dev/null 2>&1 && { "${FLOCK:-flock}" -n 9 || { ulog "другое обновление уже выполняется"; return 0; }; }

  if [[ -e "$STATE/auto-update.disabled" ]]; then return 0; fi
  if [[ -e "$STATE/maintenance.lock" ]]; then ulog "режим обслуживания — обновление пропущено"; return 0; fi

  [[ -f "$STATE/config" ]] || { ulog "нет $STATE/config — установка не выполнена"; return 1; }
  local repo channel
  repo="$(env_get "$STATE/config" SM_IMAGE_REPO)"; channel="$(env_get "$STATE/config" SM_CHANNEL)"; channel="${channel:-stable}"
  [[ -n "$repo" ]] || { ulog "SM_IMAGE_REPO не задан в $STATE/config"; return 1; }

  if (( $(free_mb) < DISK_MIN_FREE_MB )); then
    write_status "skipped_disk" "Мало места на диске ($(free_mb) МБ свободно, нужно ≥ ${DISK_MIN_FREE_MB}). Обновление отложено."
    ulog "мало места на диске — обновление пропущено"; return 0
  fi

  # 1) Узнаём, что сейчас на канале. Сбой сети — не ошибка: просто повторим через минуту.
  if ! "$DOCKER" pull -q "$repo-api:$channel" >/dev/null 2>&1; then
    ulog "не удалось получить $repo-api:$channel (сеть/доступ к реестру) — повтор позже"; return 0
  fi
  CANDIDATE_API="$("$DOCKER" image inspect --format '{{index .RepoDigests 0}}' "$repo-api:$channel" 2>/dev/null || true)"
  [[ "$CANDIDATE_API" == *"@sha256:"* ]] || { ulog "не удалось определить digest образа"; return 0; }

  [[ "$CANDIDATE_API" != "$(env_get "$STATE/deployed.env" API)" ]] || return 0           # уже развёрнуто
  [[ "$CANDIDATE_API" != "$(env_get "$STATE/failed.env" FAILED_API)" ]] || return 0      # этот релиз уже ломался — ждём новый
  ulog "найден новый релиз: $CANDIDATE_API"

  # 2) Достаём пакет развёртывания из нового образа (compose/Caddy/update.sh + release.json)
  local stage cid
  stage="$(mktemp -d "$STATE/stage.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf -- '$stage'" EXIT
  cid="$("$DOCKER" create "$CANDIDATE_API" 2>/dev/null)" || { ulog "не удалось создать контейнер из образа"; return 0; }
  "$DOCKER" cp "$cid:/app/deploy/." "$stage/" >/dev/null 2>&1 || { "$DOCKER" rm "$cid" >/dev/null 2>&1 || true; ulog "в образе нет пакета развёртывания"; return 0; }
  "$DOCKER" rm "$cid" >/dev/null 2>&1 || true
  local f
  for f in infra/compose/docker-compose.yml infra/caddy/Caddyfile bootstrap/update.sh release.json; do
    [[ -s "$stage/$f" ]] || { fail_release "bad_bundle" "В образе нет $f — релиз пропущен."; return 1; }
  done
  CANDIDATE_WEB="$(sed -n 's/.*"web":"\([^"]*\)".*/\1/p' "$stage/release.json")"
  CANDIDATE_COMMIT="$(sed -n 's/.*"commit":"\([^"]*\)".*/\1/p' "$stage/release.json")"
  [[ "$CANDIDATE_WEB" == *"@sha256:"* ]] || { fail_release "bad_bundle" "release.json не содержит digest веб-образа."; return 1; }
  "$DOCKER" pull -q "$CANDIDATE_WEB" >/dev/null 2>&1 || { ulog "не удалось скачать веб-образ — повтор позже"; return 0; }

  # 3) Сохраняем текущее состояние для отката
  rm -rf "$STATE/previous"; mkdir -p "$STATE/previous"
  if ! cp -f "$COMPOSE_DIR/docker-compose.yml" "$COMPOSE_DIR/Caddyfile" "$COMPOSE_DIR/.env" "$STATE/previous/"; then
    write_status "snapshot_failed" "Не удалось сохранить конфигурацию для отката. Обновление отменено."
    return 1
  fi

  # 4) Бэкап БД ПЕРЕД миграциями; без читаемого бэкапа не обновляемся
  if ! backup_db; then
    fail_release "backup_failed" "Не удалось сделать читаемый бэкап БД — обновление отменено, ничего не изменено."
    return 1
  fi
  ulog "бэкап БД: $BACKUP_FILE"

  # 5) Новая конфигурация + новые образы (по digest)
  cp -f "$stage/infra/compose/docker-compose.yml" "$COMPOSE_DIR/docker-compose.yml"
  cp -f "$stage/infra/caddy/Caddyfile" "$COMPOSE_DIR/Caddyfile"
  env_set "$COMPOSE_DIR/.env" SERVERMIND_API_IMAGE "$CANDIDATE_API"
  env_set "$COMPOSE_DIR/.env" SERVERMIND_WEB_IMAGE "$CANDIDATE_WEB"
  if ! dc config -q >/dev/null 2>&1; then
    restore_previous_files
    fail_release "bad_compose" "Новая конфигурация compose невалидна — релиз пропущен, ничего не изменено."
    return 1
  fi

  # 6) Миграции (транзакционные: при ошибке схема не меняется). Образы пока НЕ переключены.
  if ! dc --profile tools run --rm migrate >/dev/null 2>&1; then
    restore_previous_files
    fail_release "migration_failed" "Миграции не применились — релиз пропущен, сервисы не перезапускались. Бэкап: $BACKUP_FILE"
    return 1
  fi

  # 7) Запуск новой версии и smoke-тесты
  local deploy_error=""
  if ! dc up -d --remove-orphans >/dev/null; then
    deploy_error="Docker Compose не смог запустить новую версию."
  elif ! wait_smoke "$CANDIDATE_API" "$CANDIDATE_WEB"; then
    deploy_error="Образы или работоспособность новой версии не подтверждены за ${SMOKE_TIMEOUT} с."
  fi
  if [[ -n "$deploy_error" ]]; then
    fail_release "deploy_failed" "$deploy_error"
    rollback "$deploy_error"
    return 1
  fi

  # 8) Успех
  local deployed_tmp
  deployed_tmp="$(mktemp "$STATE/deployed.XXXXXX")"
  printf 'API=%s\nWEB=%s\nCOMMIT=%s\nDEPLOYED_AT=%s\n' \
    "$CANDIDATE_API" "$CANDIDATE_WEB" "$CANDIDATE_COMMIT" "$(date -u +%FT%TZ)" > "$deployed_tmp"
  mv -f "$deployed_tmp" "$STATE/deployed.env"
  : > "$STATE/failed.env"
  write_status "ok" "Обновлено до ${CANDIDATE_COMMIT:-unknown}."
  ulog "обновление завершено: ${CANDIDATE_COMMIT:-unknown}"
  prune_backups
  "$DOCKER" image prune -f >/dev/null 2>&1 || true   # только «висячие» слои; чужие образы не трогаем

  # Самообновление скрипта (вступит в силу при следующем запуске). Юниты systemd автоматически не обновляются.
  if ! cmp -s "$stage/bootstrap/update.sh" "$BIN_DIR/update.sh" 2>/dev/null; then
    install -m 0755 "$stage/bootstrap/update.sh" "$BIN_DIR/update.sh.new" && mv -f "$BIN_DIR/update.sh.new" "$BIN_DIR/update.sh"
    ulog "update.sh обновлён"
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then update_main "$@"; fi
