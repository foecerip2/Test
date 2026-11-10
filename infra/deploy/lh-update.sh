#!/usr/bin/env bash
# LeadHunter — обновление сервера из GitHub Releases (pull-модель, без секретов и без входящего SSH).
# Запускается systemd-таймером каждые ~3 минуты от root. Идемпотентен, не запускается параллельно.
#
# Логика: берём последний ОПУБЛИКОВАННЫЙ релиз репозитория → проверяем, что для его коммита CI прошёл (job `test`)
# → забираем исходники этого коммита → собираем образ локально → запускаем → проверка здоровья → при сбое откат.
# «Кнопка одобрения» = публикация (Publish) черновика релиза владельцем в GitHub. Черновики сервер не видит.
#
#   lh-update             — проверить и обновиться при необходимости
#   lh-update --rollback  — вернуться на предыдущую рабочую версию
set -euo pipefail

APP="${LH_APP:-/opt/leadhunter}"
SELF="${LH_SELF:-/usr/local/sbin/lh-update}"
# shellcheck disable=SC1091
. "$APP/lh.conf"                        # REPO=owner/name
API="${LH_API:-https://api.github.com}"
GIT_URL="${LH_GIT_URL:-https://github.com/$REPO.git}"
SRC="$APP/src"

exec 9>"$APP/.update.lock"
flock -n 9 || exit 0

log() { logger -t lh-update -- "$*" 2>/dev/null || true; printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
api() { curl -fsS --max-time 20 -H "Accept: application/vnd.github+json" "$API/$1"; }
compose() { docker compose --env-file "$APP/.env" -f "$APP/docker-compose.prod.yml" "$@"; }
get_env() { grep -E "^$1=" "$APP/.env" | head -1 | cut -d= -f2- || true; }
set_env() { if grep -qE "^$1=" "$APP/.env"; then sed -i "s|^$1=.*|$1=$2|" "$APP/.env"; else echo "$1=$2" >> "$APP/.env"; fi; }
read_file() { cat "$APP/$1" 2>/dev/null || true; }

healthy() {
  local cid st
  for _ in $(seq 1 40); do
    cid="$(compose ps -q web 2>/dev/null || true)"
    if [ -n "$cid" ]; then
      st="$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || true)"
      [ "$st" = healthy ] && return 0
    fi
    sleep 3
  done
  return 1
}

switch_to() {   # $1 = образ (lh-web:xxxx)
  local img="$1" previous
  previous="$(get_env WEB_IMAGE)"
  set_env WEB_IMAGE "$img"
  compose up -d --remove-orphans
  if healthy; then return 0; fi
  log "Проверка здоровья не пройдена для $img"
  if [ -n "$previous" ] && [ "$previous" != "$img" ]; then
    set_env WEB_IMAGE "$previous"
    compose up -d --remove-orphans
    log "Автоматический откат на $previous"
  fi
  return 1
}

if [ "${1:-}" = "--rollback" ]; then
  img="$(read_file .prev_good)"
  [ -n "$img" ] || { log "Нет предыдущей рабочей версии"; exit 4; }
  docker image inspect "$img" >/dev/null 2>&1 || { log "Образ $img уже удалён"; exit 4; }
  log "Откат на $img"
  switch_to "$img" && { echo "$img" > "$APP/.last_good"; log "Откат выполнен"; }
  exit 0
fi

# 1. Последний опубликованный релиз (черновики и пре-релизы API не отдаёт)
rel="$(api "repos/$REPO/releases/latest")" || { log "Релизов пока нет или GitHub недоступен"; exit 0; }
tag="$(jq -r '.tag_name // empty' <<<"$rel")"
sha="$(jq -r '.target_commitish // empty' <<<"$rel")"
[[ "$tag" =~ ^v[0-9A-Za-z._-]{1,60}$ ]] || { log "Недопустимый тег релиза: пропуск"; exit 0; }
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { log "Релиз $tag не привязан к коммиту (SHA): пропуск"; exit 0; }

[ "$(read_file .last_good_sha)" = "$sha" ] && exit 0                 # уже развёрнут
[ "$(read_file .failed_sha)" = "$sha" ] && exit 0                    # эту версию уже пробовали и она не поднялась

# 2. CI для этого коммита должен быть успешным
cr="$(api "repos/$REPO/commits/$sha/check-runs?per_page=100")" || { log "Не удалось проверить CI: пропуск"; exit 0; }
ok="$(jq -r '[.check_runs[]? | select(.name=="test" and .conclusion=="success")] | length' <<<"$cr")"
[ "${ok:-0}" -ge 1 ] || { log "CI для $sha не успешен — релиз $tag не разворачиваю"; exit 0; }

log "Новый релиз $tag ($sha): загрузка исходников"
[ -d "$SRC/.git" ] || git clone --no-checkout --filter=blob:none "$GIT_URL" "$SRC"
git -C "$SRC" fetch --depth=1 origin "$sha"
git -C "$SRC" checkout --force --detach "$sha"
[ "$(git -C "$SRC" rev-parse HEAD)" = "$sha" ] || { log "SHA после загрузки не совпал — отмена"; exit 1; }

install -m 0644 "$SRC/infra/compose/docker-compose.prod.yml" "$APP/docker-compose.prod.yml"
install -m 0644 "$SRC/infra/caddy/Caddyfile" "$APP/Caddyfile"

img="lh-web:${sha:0:12}"
log "Сборка образа $img"
if ! docker build -t "$img" -f "$SRC/apps/web/Dockerfile" "$SRC"; then
  log "Сборка не удалась для $tag"; echo "$sha" > "$APP/.failed_sha"; exit 1
fi

if switch_to "$img"; then
  [ -s "$APP/.last_good" ] && cp "$APP/.last_good" "$APP/.prev_good"
  echo "$img" > "$APP/.last_good"; echo "$sha" > "$APP/.last_good_sha"; rm -f "$APP/.failed_sha"
  log "Готово: работает релиз $tag"
  # чистка: оставляем 3 последних образа и ограничиваем кэш сборки
  docker image ls lh-web --format '{{.Repository}}:{{.Tag}}' | tail -n +4 | xargs -r docker rmi >/dev/null 2>&1 || true
  docker builder prune -f --keep-storage 2GB >/dev/null 2>&1 || true
  # обновляем сам скрипт из того же релиза (атомарно, текущий процесс не затрагивается)
  if [ -f "$SRC/infra/deploy/lh-update.sh" ] && ! cmp -s "$SRC/infra/deploy/lh-update.sh" "$SELF"; then
    install -m 0755 "$SRC/infra/deploy/lh-update.sh" "$SELF.new" && mv -f "$SELF.new" "$SELF"
  fi
else
  echo "$sha" > "$APP/.failed_sha"
  exit 1
fi
