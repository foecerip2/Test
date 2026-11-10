#!/usr/bin/env bash
# ServerMind installer для чистого Ubuntu 24.04 VPS (1–2 vCPU / 4 ГБ / 40 ГБ).
#
#   sudo bash install.sh --image-repo ghcr.io/<owner>/servermind --dry-run      # показать, что будет сделано (ничего не меняет)
#   sudo bash install.sh --image-repo ghcr.io/<owner>/servermind [--domain app.example.com] [--create-owner you@example.com]
#
# Что делает: проверяет сервер -> (при необходимости) ставит Docker из официального репозитория -> скачивает релиз из GHCR ->
# генерирует секреты ЛОКАЛЬНО (в git и в образах их нет) -> запускает PostgreSQL/API/web/Caddy -> включает автообновление (systemd timer).
# Чего НЕ делает: не останавливает и не перенастраивает чужие службы, не открывает порты в firewall, не трогает SSH, не меняет sudoers.
# Идемпотентен: повторный запуск не перегенерирует секреты.
set -Eeuo pipefail

SM_ROOT="${SM_ROOT:-/opt/servermind}"
DOCKER="${DOCKER:-docker}"
SS="${SS:-ss}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
OS_RELEASE="${OS_RELEASE:-/etc/os-release}"
MEMINFO="${MEMINFO:-/proc/meminfo}"
REQUIRE_UID="${REQUIRE_UID:-0}"   # переопределяется только в тестах
MIN_RAM_KB="${MIN_RAM_KB:-3400000}"      # «4 ГБ» VPS показывает ≈3.8 ГБ
MIN_DISK_MB="${MIN_DISK_MB:-8192}"       # целевой резерв свободного места (MD §0.1)

IMAGE_REPO="${SM_DEFAULT_IMAGE_REPO-ghcr.io/foecerip2/servermind}"; CHANNEL="stable"; DOMAIN=""; HTTP_PORT=80; HTTPS_PORT=443
GHCR_USER=""; GHCR_TOKEN_FILE=""; OWNER_EMAIL=""
ASSUME_YES=0; DRY_RUN=0; FORCE=0
LOW_MEMORY=0; SWAP_MB=0; AUTO_LOW=0
MIN_RAM_KB_LOW="${MIN_RAM_KB_LOW:-1700000}"   # «2 ГБ» VPS показывает ≈1.9 ГБ
SWAPFILE="${SWAPFILE:-/swapfile}"; SWAPS="${SWAPS:-/proc/swaps}"; FSTAB="${FSTAB:-/etc/fstab}"

log()  { printf '\033[1m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[install] ВНИМАНИЕ:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[install] ОШИБКА:\033[0m %s\n' "$*" >&2; exit 1; }

# Все действия, меняющие систему, идут через run(): в --dry-run они только печатаются.
run() { if (( DRY_RUN )); then printf '[dry-run] %s\n' "$*"; else "$@"; fi; }

usage() {
  cat <<'EOF'
Использование: install.sh --image-repo ghcr.io/<owner>/servermind [опции]

  --image-repo REPO        префикс образов в GHCR (образы: REPO-api, REPO-web); по умолчанию ghcr.io/foecerip2/servermind
  --channel TAG            канал релизов (по умолчанию stable)
  --domain NAME            домен для автоматического HTTPS (нужна A-запись и свободные порты 80/443);
                           без домена — HTTP на порту :80 (только для теста, cookie без Secure)
  --http-port N            порт HTTP (только без домена; по умолчанию 80)
  --https-port N           порт HTTPS (по умолчанию 443)
  --ghcr-user USER         пользователь GitHub для приватных образов
  --ghcr-token-file FILE   файл с токеном (scope read:packages); токен читается из файла, не из аргументов
  --create-owner EMAIL     создать владельца (пароль вводится интерактивно)
  --dry-run                только показать план, ничего не менять
  --yes                    не спрашивать подтверждение
  --low-memory             облегчённый режим для VPS с ≈2 ГБ RAM: меньшие лимиты контейнеров и настройки PostgreSQL.
                           Для теста; запас по памяти мал, на 4 ГБ используйте обычный режим
  --swap-size N            создать swap-файл N МБ (только вместе с явным флагом; по умолчанию swap не трогается;
                           рекомендуется 2048 вместе с --low-memory). Это изменение системы: оно показывается в плане
  --force                  игнорировать проверки ОС/памяти/диска (на свой риск)
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --image-repo) IMAGE_REPO="${2:?}"; shift 2 ;;
      --channel) CHANNEL="${2:?}"; shift 2 ;;
      --domain) DOMAIN="${2:?}"; shift 2 ;;
      --http-port) HTTP_PORT="${2:?}"; shift 2 ;;
      --https-port) HTTPS_PORT="${2:?}"; shift 2 ;;
      --ghcr-user) GHCR_USER="${2:?}"; shift 2 ;;
      --ghcr-token-file) GHCR_TOKEN_FILE="${2:?}"; shift 2 ;;
      --create-owner) OWNER_EMAIL="${2:?}"; shift 2 ;;
      --dry-run) DRY_RUN=1; shift ;;
      --yes) ASSUME_YES=1; shift ;;
      --low-memory) LOW_MEMORY=1; shift ;;
      --swap-size) SWAP_MB="${2:?}"; shift 2 ;;
      --force) FORCE=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "неизвестный параметр: $1 (см. --help)" ;;
    esac
  done
  [[ -n "$IMAGE_REPO" ]] || die "укажите --image-repo (например, ghcr.io/<owner>/servermind)"
  [[ "$IMAGE_REPO" =~ ^[a-z0-9._/-]+$ ]] || die "--image-repo: допустимы строчные латинские буквы, цифры, . _ / -"
  [[ "$CHANNEL" =~ ^[A-Za-z0-9._-]+$ ]] || die "--channel: недопустимое имя тега"
  [[ "$HTTP_PORT" =~ ^[0-9]+$ && "$HTTPS_PORT" =~ ^[0-9]+$ ]] || die "порты должны быть числами"
  [[ "$SWAP_MB" =~ ^[0-9]+$ ]] || die "--swap-size: число мегабайт"
  (( SWAP_MB == 0 || (SWAP_MB >= 256 && SWAP_MB <= 16384) )) || die "--swap-size: от 256 до 16384 МБ"
  if [[ -n "$DOMAIN" ]]; then
    [[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || die "--domain: некорректное доменное имя"
    [[ "$HTTP_PORT" == 80 && "$HTTPS_PORT" == 443 ]] || die "автоматический HTTPS (Let's Encrypt) работает только на портах 80/443; уберите --http-port/--https-port или --domain"
  fi
  if [[ -n "$GHCR_TOKEN_FILE" ]]; then
    [[ -n "$GHCR_USER" ]] || die "--ghcr-token-file требует --ghcr-user"
    [[ -r "$GHCR_TOKEN_FILE" ]] || die "файл токена не читается: $GHCR_TOKEN_FILE"
  fi
  if [[ -n "$OWNER_EMAIL" ]]; then [[ "$OWNER_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$ ]] || die "--create-owner: некорректный email"; fi
  return 0
}

# ───────── проверки сервера (только чтение) ─────────
preflight_os() {
  local id="" ver=""
  # shellcheck disable=SC1090  # путь переопределяется только в тестах
  if [[ -r "$OS_RELEASE" ]]; then id="$(. "$OS_RELEASE" && echo "${ID:-}")"; ver="$(. "$OS_RELEASE" && echo "${VERSION_ID:-}")"; fi
  if [[ "$id" != ubuntu || "$ver" != "24.04" ]]; then
    (( FORCE )) && { warn "ОС «$id $ver», проверялось на Ubuntu 24.04 (продолжаю из-за --force)"; return 0; }
    die "ожидается Ubuntu 24.04 LTS, найдено: ${id:-?} ${ver:-?} (обойти: --force)"
  fi
  case "$(uname -m)" in x86_64|aarch64) ;; *) die "неподдерживаемая архитектура: $(uname -m)" ;; esac
}

preflight_resources() {
  local ram_kb free_mb dir="$SM_ROOT"
  ram_kb="$(awk '/^MemTotal:/ {print $2}' "$MEMINFO")"
  while [[ ! -d "$dir" && "$dir" != / ]]; do dir="$(dirname "$dir")"; done
  free_mb="$(df -Pm "$dir" | awk 'NR==2 {print $4}')"
  log "ресурсы: RAM $((ram_kb / 1024)) МБ, свободно на диске $free_mb МБ"
  local need_kb="$MIN_RAM_KB" need_txt="≈4 ГБ"
  # Авто: памяти меньше нормы, но достаточно для облегчённого режима → включаем его (и swap, если его нет) — видно в плане, требует подтверждения
  if (( ! LOW_MEMORY && ! FORCE && ram_kb < MIN_RAM_KB && ram_kb >= MIN_RAM_KB_LOW )); then
    LOW_MEMORY=1; AUTO_LOW=1
    warn "RAM $((ram_kb / 1024)) МБ < 4 ГБ: автоматически включён облегчённый режим (--low-memory)"
    if (( SWAP_MB == 0 )) && [[ "$(awk 'NR>1' "$SWAPS" 2>/dev/null | wc -l)" == 0 ]]; then SWAP_MB=2048; warn "swap не подключён: в план добавлено создание swap-файла 2048 МБ"; fi
  fi
  if (( LOW_MEMORY )); then need_kb="$MIN_RAM_KB_LOW"; need_txt="≈2 ГБ (облегчённый режим)"; fi
  if (( ram_kb < need_kb )); then
    if (( FORCE )); then warn "мало RAM (--force)"
    elif (( LOW_MEMORY )); then die "мало памяти даже для облегчённого режима: нужно $need_txt (найдено $((ram_kb / 1024)) МБ). Обойти: --force"
    else die "мало памяти: нужно ≈4 ГБ (найдено $((ram_kb / 1024)) МБ). Для теста на ≈2 ГБ добавьте --low-memory (подробности: --help). Обойти: --force"; fi
  fi
  if (( free_mb < MIN_DISK_MB )); then
    if (( FORCE )); then warn "мало места (--force)"; else die "мало места: нужно ≥ ${MIN_DISK_MB} МБ свободно (найдено $free_mb МБ). Обойти: --force"; fi
  fi
}

# DNS-проверка домена: только предупреждение (не блокирует; Let's Encrypt всё равно потребует A-запись)
check_domain() {
  [[ -n "$DOMAIN" ]] || return 0
  getent hosts "$DOMAIN" >/dev/null 2>&1 || warn "домен $DOMAIN пока не резолвится: создайте A-запись на IP этого сервера, иначе HTTPS-сертификат не будет выдан"
  return 0
}

port_busy() { "$SS" -ltnH "( sport = :$1 )" 2>/dev/null | grep -q .; }

ours_running() { command -v "$DOCKER" >/dev/null 2>&1 && "$DOCKER" ps --filter label=com.docker.compose.project=servermind -q 2>/dev/null | grep -q .; }

check_ports() {
  ours_running && return 0   # повторный запуск: порты заняты нашим же стеком
  local p
  for p in "$HTTP_PORT" "$HTTPS_PORT"; do
    if port_busy "$p"; then
      die "порт $p уже занят другой службой. Установщик НЕ останавливает чужие службы (nginx/caddy и т.п.).
  Варианты: освободите порт сами; либо установка без домена на другом порту (--http-port 8080), либо отдельный IP/сервер."
    fi
  done
}

print_plan() {
  local mode="HTTP на порту $HTTP_PORT (без шифрования, только для теста)"
  [[ -n "$DOMAIN" ]] && mode="HTTPS для $DOMAIN (Let's Encrypt, порты 80/443)"
  cat <<EOF

────────── План установки ServerMind ──────────
Образы:           $IMAGE_REPO-api / $IMAGE_REPO-web (канал $CHANNEL, по digest)
Каталог:          $SM_ROOT  (env/ — секреты 600, compose/, state/, backups/)
Доступ:           $mode
Docker:           $(command -v "$DOCKER" >/dev/null 2>&1 && echo "уже установлен — используется как есть" || echo "будет установлен из официального репозитория Docker (apt)")
Режим памяти:     $( (( AUTO_LOW )) && echo "(выбран автоматически) ")$( (( LOW_MEMORY )) && echo "ОБЛЕГЧЁННЫЙ (лимиты: PostgreSQL 320m, API 256m, web 224m, Caddy 48m; запас мал, замеров на 2 ГБ нет)" || echo "обычный (рассчитан на 4 ГБ)")
Swap:             $( if (( SWAP_MB > 0 )); then echo "будет создан файл $SWAPFILE ${SWAP_MB} МБ (если swap ещё не подключён) и добавлен в $FSTAB"; else echo "не изменяется"; fi)
Автообновление:   systemd timer servermind-update.timer (раз в минуту; бэкап БД → миграции → smoke → откат при сбое)

Будет изменено:   $SM_ROOT, ${SYSTEMD_DIR}/servermind-update.{service,timer}$(command -v "$DOCKER" >/dev/null 2>&1 || echo ", apt-репозиторий и пакеты Docker")
НЕ будет изменено: чужие службы и их конфигурация, SSH, firewall (ufw/iptables), sudoers, существующие контейнеры и БД
Важно:            Docker публикует порты контейнеров в обход ufw — публикуются только порты Caddy ($HTTP_PORT/$HTTPS_PORT).
                  Файл $SM_ROOT/env/api.env содержит мастер-ключ шифрования: сохраните его копию ВНЕ сервера, иначе после потери
                  диска зашифрованные данные (SSH-ключи, ключи провайдеров, TOTP) не восстановить.
Сейчас на сервере слушают порты:
$("$SS" -ltnH 2>/dev/null | awk '{print "                  " $4}' | sort -u | head -12)
────────────────────────────────────────────────
EOF
}

confirm() {
  (( ASSUME_YES )) && return 0
  [[ -t 0 ]] || die "нет терминала для подтверждения — добавьте --yes (после просмотра плана --dry-run)"
  local a; read -r -p "Продолжить установку? [y/N] " a
  [[ "$a" == y || "$a" == Y ]] || die "отменено пользователем"
}

# ───────── установка ─────────
install_docker() {
  if command -v "$DOCKER" >/dev/null 2>&1 && "$DOCKER" compose version >/dev/null 2>&1; then log "Docker и Compose уже установлены — не трогаю"; return 0; fi
  command -v "$DOCKER" >/dev/null 2>&1 && die "Docker есть, но нет плагина compose. Установите docker-compose-plugin вручную и повторите."
  log "устанавливаю Docker из официального репозитория (по инструкции docs.docker.com/engine/install/ubuntu)"
  run apt-get update
  run apt-get install -y ca-certificates curl
  run install -m 0755 -d /etc/apt/keyrings
  run curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  run chmod a+r /etc/apt/keyrings/docker.asc
  if (( DRY_RUN )); then
    # shellcheck disable=SC2016  # в dry-run выводится текст команды, подстановка не нужна
    echo '[dry-run] echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu <codename> stable" > /etc/apt/sources.list.d/docker.list'
  else
    # shellcheck disable=SC1091
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" > /etc/apt/sources.list.d/docker.list
  fi
  run apt-get update
  run apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  run systemctl enable --now docker
}

ghcr_login() {
  [[ -n "$GHCR_TOKEN_FILE" ]] || return 0
  log "вход в ghcr.io как $GHCR_USER (токен читается из файла)"
  if (( DRY_RUN )); then echo "[dry-run] docker login ghcr.io -u $GHCR_USER --password-stdin < $GHCR_TOKEN_FILE"; else "$DOCKER" login ghcr.io -u "$GHCR_USER" --password-stdin < "$GHCR_TOKEN_FILE" >/dev/null; fi
}

fetch_bundle() {  # заполняет STAGE, API_REF, WEB_REF, COMMIT
  STAGE="$(mktemp -d)"
  log "скачиваю релиз $IMAGE_REPO-api:$CHANNEL"
  if ! "$DOCKER" pull -q "$IMAGE_REPO-api:$CHANNEL" >/dev/null 2>&1; then
    # Образ приватный (или ещё не опубликован): при интерактивном запуске просим токен один раз, без записи в аргументы/историю
    if [[ -z "$GHCR_TOKEN_FILE" && -t 0 ]]; then
      local owner tok; owner="${IMAGE_REPO#ghcr.io/}"; owner="${owner%%/*}"
      warn "образ недоступен без авторизации. Введите GitHub token (classic, scope read:packages) для пользователя $owner или Enter, чтобы отменить"
      read -r -s -p "token: " tok; echo
      [[ -n "$tok" ]] || die "отменено. Либо сделайте пакеты публичными (GitHub → Packages → Package settings → Change visibility), либо повторите с токеном"
      printf '%s' "$tok" | "$DOCKER" login ghcr.io -u "$owner" --password-stdin >/dev/null || die "GHCR отклонил токен"
    fi
    "$DOCKER" pull -q "$IMAGE_REPO-api:$CHANNEL" >/dev/null || die "не удалось скачать образ. Проверьте имя, что CI уже опубликовал релиз, и доступ (приватный пакет → --ghcr-user/--ghcr-token-file)"
  fi
  API_REF="$("$DOCKER" image inspect --format '{{index .RepoDigests 0}}' "$IMAGE_REPO-api:$CHANNEL")"
  [[ "$API_REF" == *@sha256:* ]] || die "не удалось определить digest образа"
  local cid; cid="$("$DOCKER" create "$API_REF")"
  "$DOCKER" cp "$cid:/app/deploy/." "$STAGE/" >/dev/null; "$DOCKER" rm "$cid" >/dev/null
  WEB_REF="$(sed -n 's/.*"web":"\([^"]*\)".*/\1/p' "$STAGE/release.json")"
  COMMIT="$(sed -n 's/.*"commit":"\([^"]*\)".*/\1/p' "$STAGE/release.json")"
  [[ "$WEB_REF" == *@sha256:* ]] || die "в релизе нет digest веб-образа (release.json)"
  "$DOCKER" pull -q "$WEB_REF" >/dev/null || die "не удалось скачать веб-образ"
  log "релиз: ${COMMIT:-unknown}"
}

# Секреты: создаются ТОЛЬКО если файла ещё нет (повторный запуск ничего не перегенерирует).
generate_env() {
  local envdir="$SM_ROOT/env" secure="true" pw key
  [[ -n "$DOMAIN" ]] || secure="false"
  ( umask 077
    mkdir -p "$envdir"
    if [[ ! -f "$envdir/postgres.env" ]]; then
      pw="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
      printf 'POSTGRES_USER=servermind\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=servermind\n' "$pw" > "$envdir/postgres.env"
    fi
    if [[ ! -f "$envdir/api.env" ]]; then
      pw="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$envdir/postgres.env")"
      key="$(head -c 32 /dev/urandom | base64 -w0)"
      printf 'ENVIRONMENT=production\nDATABASE_URL=postgresql+psycopg://servermind:%s@postgres:5432/servermind\nENCRYPTION_MASTER_KEY=%s\nCOOKIE_SECURE=%s\nALLOW_PRIVATE_TARGETS=false\nEXECUTION_ENABLED=false\n' \
        "$pw" "$key" "$secure" > "$envdir/api.env"
    fi )
  chmod 700 "$envdir"; chmod 600 "$envdir/postgres.env" "$envdir/api.env"
}

# Создаёт swap-файл только по явному --swap-size и только если swap ещё не подключён и файла нет.
setup_swap() {
  (( SWAP_MB > 0 )) || return 0
  if [[ -e "$SWAPFILE" ]]; then warn "$SWAPFILE уже существует — swap не создаю"; return 0; fi
  if [[ "$(awk 'NR>1' "$SWAPS" 2>/dev/null | wc -l)" != 0 ]]; then warn "swap уже подключён — не создаю второй"; return 0; fi
  log "создаю swap-файл $SWAPFILE (${SWAP_MB} МБ)"
  run dd if=/dev/zero of="$SWAPFILE" bs=1M count="$SWAP_MB" status=none
  run chmod 600 "$SWAPFILE"
  run mkswap "$SWAPFILE"
  run swapon "$SWAPFILE"
  if (( DRY_RUN )); then echo "[dry-run] echo '$SWAPFILE none swap sw 0 0' >> $FSTAB"; else echo "$SWAPFILE none swap sw 0 0" >> "$FSTAB"; fi
}

write_compose_env() {
  local f="$SM_ROOT/compose/.env" site=":80"
  [[ -n "$DOMAIN" ]] && site="$DOMAIN"
  mkdir -p "$SM_ROOT/compose"
  ( umask 077; : >> "$f" )
  local kv
  for kv in "SERVERMIND_API_IMAGE=$API_REF" "SERVERMIND_WEB_IMAGE=$WEB_REF" "SERVERMIND_HTTP_PORT=$HTTP_PORT" \
            "SERVERMIND_HTTPS_PORT=$HTTPS_PORT" "SERVERMIND_SITE_ADDRESS=$site"; do
    env_set "$f" "${kv%%=*}" "${kv#*=}"
  done
  if (( LOW_MEMORY )); then
    for kv in "SM_MEM_POSTGRES=320m" "SM_MEM_API=256m" "SM_MEM_WEB=224m" "SM_MEM_CADDY=48m" \
              "SM_PG_SHARED_BUFFERS=64MB" "SM_PG_MAX_CONNECTIONS=30" "SM_WEB_NODE_OPTIONS=--max-old-space-size=160"; do
      env_set "$f" "${kv%%=*}" "${kv#*=}"
    done
  fi
}

install_files() {
  mkdir -p "$SM_ROOT"/{compose,bin,state,backups}; chmod 700 "$SM_ROOT/backups"
  install -m 0644 "$STAGE/infra/compose/docker-compose.yml" "$SM_ROOT/compose/docker-compose.yml"
  install -m 0644 "$STAGE/infra/caddy/Caddyfile" "$SM_ROOT/compose/Caddyfile"
  install -m 0755 "$STAGE/bootstrap/update.sh" "$SM_ROOT/bin/update.sh"
  printf 'SM_IMAGE_REPO=%s\nSM_CHANNEL=%s\n' "$IMAGE_REPO" "$CHANNEL" > "$SM_ROOT/state/config"
  install -m 0644 "$STAGE/bootstrap/systemd/servermind-update.service" "$SYSTEMD_DIR/servermind-update.service"
  install -m 0644 "$STAGE/bootstrap/systemd/servermind-update.timer" "$SYSTEMD_DIR/servermind-update.timer"
}

first_deploy() {
  # функции dc/wait_smoke/env_set берём из того же update.sh, который будет обновлять систему дальше
  # shellcheck disable=SC1091
  source "$SM_ROOT/bin/update.sh"
  log "запускаю PostgreSQL"
  dc up -d postgres
  local i=0
  until dc exec -T postgres pg_isready -U servermind -d servermind >/dev/null 2>&1; do
    (( ++i > 40 )) && die "PostgreSQL не стал готовым за 120 с (docker compose -p servermind logs postgres)"; sleep 3
  done
  log "применяю миграции"
  dc --profile tools run --rm migrate
  log "запускаю API, web и Caddy"
  dc up -d
  SMOKE_TIMEOUT="${INSTALL_SMOKE_TIMEOUT:-180}" wait_smoke "$API_REF" "$WEB_REF" || die "сервисы не прошли проверку работоспособности (docker compose -p servermind ps / logs). Конфигурация сохранена в $SM_ROOT."
  env_set "$SM_ROOT/state/deployed.env" API "$API_REF"
  env_set "$SM_ROOT/state/deployed.env" WEB "$WEB_REF"
  env_set "$SM_ROOT/state/deployed.env" COMMIT "${COMMIT:-unknown}"
  env_set "$SM_ROOT/state/deployed.env" DEPLOYED_AT "$(date -u +%FT%TZ)"
}

create_owner() {
  [[ -n "$OWNER_EMAIL" ]] || return 0
  # shellcheck disable=SC1091
  source "$SM_ROOT/bin/update.sh"
  if [[ -t 0 ]]; then dc run --rm -it api python -m app.cli create-user --email "$OWNER_EMAIL" --role owner
  else warn "нет терминала: создайте владельца позже: docker compose -p servermind --project-directory $SM_ROOT/compose run --rm -it api python -m app.cli create-user --email $OWNER_EMAIL --role owner"; fi
}

enable_timer() { "$SYSTEMCTL" daemon-reload; "$SYSTEMCTL" enable --now servermind-update.timer; }

final_report() {
  local url="http://<IP сервера>:$HTTP_PORT"
  [[ -n "$DOMAIN" ]] && url="https://$DOMAIN"
  cat <<EOF

✔ ServerMind установлен: $url
  Статус обновлений:   cat $SM_ROOT/state/last-update.json ;  journalctl -u servermind-update -n 50
  Приостановить:       touch $SM_ROOT/state/auto-update.disabled   (возобновить: rm этого файла)
  Логи сервисов:       docker compose -p servermind --project-directory $SM_ROOT/compose logs -f --tail 100
  ВАЖНО: сохраните копию $SM_ROOT/env/api.env (мастер-ключ шифрования) вне сервера.
  ВАЖНО: бэкапы БД лежат в $SM_ROOT/backups на этом же диске — настройте копирование за пределы сервера.
EOF
  [[ -z "$DOMAIN" ]] && warn "режим HTTP без шифрования: пароли и сессии идут открытым текстом — используйте только для теста, затем подключите домен (--domain)."
  return 0
}

main() {
  parse_args "$@"
  preflight_os
  preflight_resources
  (( DRY_RUN )) || [[ "$(id -u)" == "$REQUIRE_UID" ]] || die "запустите от root (sudo bash install.sh …), либо используйте --dry-run"
  check_ports
  check_domain
  print_plan
  if (( DRY_RUN )); then log "dry-run: ничего не изменено"; return 0; fi
  confirm
  setup_swap
  install_docker
  ghcr_login
  fetch_bundle
  # shellcheck disable=SC1091
  source "$STAGE/bootstrap/update.sh"   # env_set/dc/wait_smoke
  generate_env
  install_files
  write_compose_env
  first_deploy
  create_owner
  enable_timer
  rm -rf -- "$STAGE"
  final_report
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
