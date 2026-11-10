#!/usr/bin/env bash
# Тесты install.sh на поддельном docker. Реальный Docker/systemd/apt не используются; ничего не ставится в систему.
# shellcheck disable=SC2016,SC1090,SC2034,SC2155  # условия check — строки для eval; переменные используются внутри eval/подоболочек
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL="$HERE/../install.sh"
UPDATE="$HERE/../update.sh"
FAKE="$HERE/fake_docker.sh"
chmod +x "$FAKE"
PASS=0; FAILN=0
ok()  { PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"; }
bad() { FAILN=$((FAILN + 1)); printf '  FAIL  %s\n' "$1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

NEW_API="ghcr.io/o/servermind-api@sha256:new"
NEW_WEB="ghcr.io/o/servermind-web@sha256:newweb"

setup() {
  T="$(mktemp -d)"
  export SM_ROOT="$T/sm" SYSTEMD_DIR="$T/systemd" FAKE_LOG="$T/docker.log" FAKE_BUNDLE="$T/bundle" FAKE_API_DIGEST="$NEW_API" FAKE_FAIL=""
  export DOCKER="$FAKE" SYSTEMCTL="$T/systemctl" SS="$T/ss" SM_NO_SYSLOG=1 SMOKE_TIMEOUT=2 SMOKE_INTERVAL=1 INSTALL_SMOKE_TIMEOUT=2
  export OS_RELEASE="$T/os-release" MEMINFO="$T/meminfo" MIN_DISK_MB=1 REQUIRE_UID="$(id -u)"
  mkdir -p "$SYSTEMD_DIR" "$FAKE_BUNDLE/infra/compose" "$FAKE_BUNDLE/infra/caddy" "$FAKE_BUNDLE/bootstrap/systemd"
  printf 'ID=ubuntu\nVERSION_ID="24.04"\n' > "$OS_RELEASE"
  printf 'MemTotal:        3900000 kB\n' > "$MEMINFO"
  printf '#!/usr/bin/env bash\necho "systemctl $*" >> "%s"\n' "$T/systemctl.log" > "$SYSTEMCTL"; chmod +x "$SYSTEMCTL"
  # поддельный ss: печатает «слушающие» порты из FAKE_BUSY_PORTS
  cat > "$SS" <<'SSEOF'
#!/usr/bin/env bash
# ss -ltnH ["( sport = :N )"]: без фильтра печатает все «занятые» порты, с фильтром — только запрошенный
q="${*: -1}"; want=""; [[ "$q" == *"sport = :"* ]] && want="${q##*:}" && want="${want//[^0-9]/}"
for p in ${FAKE_BUSY_PORTS:-}; do [[ -z "$want" || "$want" == "$p" ]] && echo "LISTEN 0 4096 0.0.0.0:$p 0.0.0.0:*"; done
exit 0
SSEOF
  chmod +x "$SS"
  printf 'services: {}\n' > "$FAKE_BUNDLE/infra/compose/docker-compose.yml"; printf ':80 {}\n' > "$FAKE_BUNDLE/infra/caddy/Caddyfile"
  cp "$UPDATE" "$FAKE_BUNDLE/bootstrap/update.sh"
  cp "$HERE/../systemd/"* "$FAKE_BUNDLE/bootstrap/systemd/"
  printf '{"commit":"abc123","web":"%s"}\n' "$NEW_WEB" > "$FAKE_BUNDLE/release.json"
  unset FAKE_BUSY_PORTS
}
inst() { bash "$INSTALL" "$@" > "$T/out.log" 2>&1; echo $? > "$T/rc"; RC="$(cat "$T/rc")"; export RC; }
log_has() { grep -q -- "$1" "$FAKE_LOG" 2>/dev/null; }
val() { sed -n "s/^$2=//p" "$1" | tail -n 1; }
REPO=(--image-repo ghcr.io/o/servermind)

echo "== 1. разбор и проверка аргументов"
setup
SM_DEFAULT_IMAGE_REPO="" inst; check "без --image-repo (и без значения по умолчанию) → ошибка" '[[ "$RC" != 0 ]] && grep -q "image-repo" "$T/out.log"'
inst --image-repo "GHCR.io/Bad Name" --dry-run; check "недопустимые символы в --image-repo" '[[ "$RC" != 0 ]]'
inst "${REPO[@]}" --domain app.example.com --http-port 8080 --dry-run; check "HTTPS-домен несовместим с нестандартными портами" '[[ "$RC" != 0 ]] && grep -q "80/443" "$T/out.log"'
inst "${REPO[@]}" --domain "bad domain" --dry-run; check "некорректный домен" '[[ "$RC" != 0 ]]'
inst "${REPO[@]}" --ghcr-token-file "$T/none" --ghcr-user u --dry-run; check "несуществующий файл токена" '[[ "$RC" != 0 ]]'
: > "$T/tok"; inst "${REPO[@]}" --ghcr-token-file "$T/tok" --dry-run; check "токен без пользователя" '[[ "$RC" != 0 ]] && grep -q "ghcr-user" "$T/out.log"'
inst "${REPO[@]}" --create-owner "not-an-email" --dry-run; check "некорректный email владельца" '[[ "$RC" != 0 ]]'
inst "${REPO[@]}" --bogus; check "неизвестный параметр" '[[ "$RC" != 0 ]]'
inst --help; check "--help работает без аргументов" '[[ "$RC" == 0 ]] && grep -q "Использование" "$T/out.log"'

echo "== 2. dry-run: показывает план и НИЧЕГО не меняет"
setup; inst "${REPO[@]}" --dry-run
check "код 0 и явное «ничего не изменено»" '[[ "$RC" == 0 ]] && grep -q "dry-run: ничего не изменено" "$T/out.log"'
check "каталог установки не создан" '[[ ! -e "$SM_ROOT" ]]'
check "systemd-юниты не записаны" '[[ -z "$(ls -A "$SYSTEMD_DIR")" ]]'
check "не скачивал образы и не запускал compose (допустим только read-only docker ps)" '! log_has "docker pull" && ! log_has "docker compose" && ! log_has "docker create" && ! log_has "docker login"'
check "план перечисляет, что НЕ будет изменено" 'grep -q "НЕ будет изменено" "$T/out.log" && grep -q "SSH, firewall" "$T/out.log"'
check "план предупреждает про мастер-ключ и ufw" 'grep -q "мастер-ключ" "$T/out.log" && grep -q "в обход ufw" "$T/out.log"'
inst "${REPO[@]}" --domain app.example.com --dry-run; check "с доменом план говорит про HTTPS" 'grep -q "HTTPS для app.example.com" "$T/out.log"'

echo "== 3. проверки сервера"
setup; printf 'ID=debian\nVERSION_ID="12"\n' > "$OS_RELEASE"; inst "${REPO[@]}" --dry-run
check "не Ubuntu 24.04 → отказ" '[[ "$RC" != 0 ]] && grep -q "Ubuntu 24.04" "$T/out.log"'
inst "${REPO[@]}" --dry-run --force; check "--force разрешает (с предупреждением)" '[[ "$RC" == 0 ]] && grep -q "ВНИМАНИЕ" "$T/out.log"'
setup; printf 'MemTotal:        1000000 kB\n' > "$MEMINFO"; inst "${REPO[@]}" --dry-run
check "мало RAM → отказ" '[[ "$RC" != 0 ]] && grep -q "мало памяти" "$T/out.log"'
setup; MIN_DISK_MB=999999999 inst "${REPO[@]}" --dry-run
check "мало диска → отказ" '[[ "$RC" != 0 ]] && grep -q "мало места" "$T/out.log"'
setup; export FAKE_BUSY_PORTS="80"; inst "${REPO[@]}" --dry-run
check "порт 80 занят чужой службой → отказ, чужое не трогаем" '[[ "$RC" != 0 ]] && grep -q "НЕ останавливает чужие службы" "$T/out.log"'
check "в логе docker нет остановок/удалений" '! log_has " stop" && ! log_has " kill" && ! log_has " rm "'
setup; export FAKE_BUSY_PORTS="443"; inst "${REPO[@]}" --dry-run; check "порт 443 занят → отказ" '[[ "$RC" != 0 ]]'
setup; export FAKE_BUSY_PORTS="80"; inst "${REPO[@]}" --http-port 8080 --dry-run; check "альтернативный HTTP-порт обходит конфликт" '[[ "$RC" == 0 ]]'
setup; inst "${REPO[@]}"; check "без --yes и без терминала — не продолжает" '[[ "$RC" != 0 ]] && grep -q -- "--yes" "$T/out.log" && [[ ! -e "$SM_ROOT" ]]'
setup; export FAKE_BUSY_PORTS="80 443"; : > "$T/ours"
printf '#!/usr/bin/env bash\nif [[ "$1" == ps ]]; then echo abc123; exit 0; fi\nexec "%s" "$@"\n' "$FAKE" > "$T/docker_ours"; chmod +x "$T/docker_ours"
DOCKER="$T/docker_ours" inst "${REPO[@]}" --dry-run
check "повторный запуск: порты заняты НАШИМ стеком — не ошибка" '[[ "$RC" == 0 ]]'

echo "== 4. секреты и конфигурация"
setup; export DRY_RUN=0; ( source "$INSTALL"; source "$UPDATE"; DOMAIN=""; generate_env ) 2>/dev/null
E="$SM_ROOT/env"
check "файлы секретов созданы с правами 600, каталог 700" '[[ "$(stat -c %a "$E/api.env")" == 600 && "$(stat -c %a "$E/postgres.env")" == 600 && "$(stat -c %a "$E")" == 700 ]]'
check "мастер-ключ — base64 ровно 32 байта" '[[ "$(printf %s "$(val "$E/api.env" ENCRYPTION_MASTER_KEY)" | base64 -d | wc -c)" == 32 ]]'
check "пароль БД одинаков в postgres.env и DATABASE_URL" 'pw="$(val "$E/postgres.env" POSTGRES_PASSWORD)"; [[ ${#pw} -ge 40 ]] && grep -q "servermind:$pw@postgres:5432" "$E/api.env"'
check "без домена COOKIE_SECURE=false, приватные цели и исполнение выключены" '[[ "$(val "$E/api.env" COOKIE_SECURE)" == false && "$(val "$E/api.env" ALLOW_PRIVATE_TARGETS)" == false && "$(val "$E/api.env" EXECUTION_ENABLED)" == false ]]'
SUM1="$(cat "$E"/*.env | sha256sum)"; ( source "$INSTALL"; source "$UPDATE"; DOMAIN="x.example.com"; generate_env ) 2>/dev/null
check "повторный запуск НЕ перегенерирует секреты" '[[ "$(cat "$E"/*.env | sha256sum)" == "$SUM1" ]]'
setup; ( source "$INSTALL"; source "$UPDATE"; DOMAIN="x.example.com"; generate_env ) 2>/dev/null
check "с доменом COOKIE_SECURE=true" '[[ "$(val "$SM_ROOT/env/api.env" COOKIE_SECURE)" == true ]]'
PYBIN="$HERE/../../apps/api/.venv/bin/python"
if [[ -x "$PYBIN" ]]; then
  check "api.env принимается РЕАЛЬНЫМ конфигом API (pydantic Settings)" '(cd "$HERE/../../apps/api" && "$PYBIN" -c "
from app.core.config import Settings
s = Settings(_env_file=\"$SM_ROOT/env/api.env\")
assert s.environment == \"production\" and s.cookie_secure is True and s.allow_private_targets is False and len(s.master_key_bytes) == 32
")'
else echo "  SKIP  проверка api.env реальным конфигом (нет apps/api/.venv)"; fi
setup; mkdir -p "$SM_ROOT/compose"; printf 'SERVERMIND_HTTP_PORT=80\nCUSTOM=keep\n' > "$SM_ROOT/compose/.env"
( source "$INSTALL"; source "$UPDATE"; API_REF=a@sha256:1; WEB_REF=w@sha256:2; HTTP_PORT=8080; HTTPS_PORT=443; DOMAIN=""; write_compose_env; DOMAIN="d.example.com"; write_compose_env ) 2>/dev/null
check ".env: ключи записаны, чужие сохранены, повтор обновляет, права 600" '[[ "$(val "$SM_ROOT/compose/.env" SERVERMIND_HTTP_PORT)" == 8080 && "$(val "$SM_ROOT/compose/.env" CUSTOM)" == keep && "$(val "$SM_ROOT/compose/.env" SERVERMIND_SITE_ADDRESS)" == d.example.com && "$(stat -c %a "$SM_ROOT/compose/.env")" == 600 && "$(grep -c "^SERVERMIND_API_IMAGE=" "$SM_ROOT/compose/.env")" == 1 ]]'

echo "== 5. полная установка на поддельном docker"
setup; inst "${REPO[@]}" --yes
check "код 0, итоговое сообщение" '[[ "$RC" == 0 ]] && grep -q "ServerMind установлен" "$T/out.log"'
check "файлы установлены" '[[ -s "$SM_ROOT/compose/docker-compose.yml" && -s "$SM_ROOT/compose/Caddyfile" && -x "$SM_ROOT/bin/update.sh" ]]'
check "образы закреплены по digest" '[[ "$(val "$SM_ROOT/compose/.env" SERVERMIND_API_IMAGE)" == "$NEW_API" && "$(val "$SM_ROOT/compose/.env" SERVERMIND_WEB_IMAGE)" == "$NEW_WEB" ]]'
check "state/config и deployed.env записаны" '[[ "$(val "$SM_ROOT/state/config" SM_IMAGE_REPO)" == ghcr.io/o/servermind && "$(val "$SM_ROOT/state/deployed.env" API)" == "$NEW_API" && "$(val "$SM_ROOT/state/deployed.env" COMMIT)" == abc123 ]]'
check "юниты systemd установлены и таймер включён" '[[ -s "$SYSTEMD_DIR/servermind-update.timer" && -s "$SYSTEMD_DIR/servermind-update.service" ]] && grep -q "enable --now servermind-update.timer" "$T/systemctl.log"'
check "порядок: БД → миграции → остальные сервисы" '[[ "$(grep -n "up -d postgres" "$FAKE_LOG" | head -1 | cut -d: -f1)" -lt "$(grep -n "run --rm migrate" "$FAKE_LOG" | head -1 | cut -d: -f1)" && "$(grep -n "run --rm migrate" "$FAKE_LOG" | head -1 | cut -d: -f1)" -lt "$(grep -n " up -d$" "$FAKE_LOG" | head -1 | cut -d: -f1)" ]]'
check "каталог бэкапов 700" '[[ "$(stat -c %a "$SM_ROOT/backups")" == 700 ]]'
check "docker не останавливал/не удалял чужое" '! log_has " stop" && ! log_has " kill" && ! log_has "system prune" && ! log_has "volume rm"'
check "вывод не содержит секретов" '! grep -qE "$(val "$SM_ROOT/env/postgres.env" POSTGRES_PASSWORD)|$(val "$SM_ROOT/env/api.env" ENCRYPTION_MASTER_KEY | cut -c1-20)" "$T/out.log"'
SUM="$(cat "$SM_ROOT"/env/*.env | sha256sum)"
echo "-- связка с обновлятором: сразу после установки update.sh ничего не делает"
: > "$FAKE_LOG"; bash "$UPDATE" > "$T/upd.log" 2>&1; URC=$?
check "update.sh: тот же релиз → no-op" '[[ "$URC" == 0 ]] && ! log_has "compose"'
echo "-- повторная установка идемпотентна"
: > "$FAKE_LOG"; inst "${REPO[@]}" --yes
check "второй запуск успешен, секреты не изменились" '[[ "$RC" == 0 && "$(cat "$SM_ROOT"/env/*.env | sha256sum)" == "$SUM" ]]'
echo "-- выходит новый релиз → обновлятор, установленный установщиком, обновляет"
export FAKE_API_DIGEST="ghcr.io/o/servermind-api@sha256:v2"; printf '{"commit":"def456","web":"ghcr.io/o/servermind-web@sha256:web2"}\n' > "$FAKE_BUNDLE/release.json"; : > "$FAKE_LOG"
bash "$UPDATE" > "$T/upd.log" 2>&1; URC=$?
check "обновление прошло, состояние обновлено" '[[ "$URC" == 0 && "$(val "$SM_ROOT/state/deployed.env" COMMIT)" == def456 && "$(val "$SM_ROOT/compose/.env" SERVERMIND_WEB_IMAGE)" == ghcr.io/o/servermind-web@sha256:web2 ]]'
check "перед миграциями сделан бэкап БД" 'ls "$SM_ROOT"/backups/db-*.dump >/dev/null 2>&1'

echo "== 6. установка не удалась → без «полуустановленных» сюрпризов"
setup; export FAKE_FAIL="pull"; inst "${REPO[@]}" --yes
check "не скачался образ → понятная ошибка, юниты не включены" '[[ "$RC" != 0 ]] && grep -q "не удалось скачать образ" "$T/out.log" && [[ ! -e "$T/systemctl.log" ]]'
setup; printf '{"commit":"x","web":"ghcr.io/o/servermind-web:latest"}\n' > "$FAKE_BUNDLE/release.json"; inst "${REPO[@]}" --yes
check "веб-образ без digest отвергается" '[[ "$RC" != 0 ]] && grep -q "digest веб-образа" "$T/out.log" && [[ ! -e "$SYSTEMD_DIR/servermind-update.timer" ]]'
setup; export FAKE_FAIL="smoke_all"; inst "${REPO[@]}" --yes
check "smoke не прошёл → ошибка, автообновление не включено" '[[ "$RC" != 0 ]] && grep -q "проверку работоспособности" "$T/out.log" && [[ ! -e "$T/systemctl.log" ]]'

echo "== 7. приватные образы: токен только из файла"
setup; printf 'ghp_FAKETOKENFORTEST\n' > "$T/tok"; chmod 600 "$T/tok"; inst "${REPO[@]}" --yes --ghcr-user someone --ghcr-token-file "$T/tok"
check "docker login с --password-stdin; токена нет в аргументах и логах" 'log_has "login ghcr.io -u someone --password-stdin" && ! log_has "ghp_FAKETOKEN" && ! grep -q ghp_FAKETOKEN "$T/out.log"'

echo "== 8. облегчённый режим (--low-memory) и swap"
setup; printf 'MemTotal:        2015000 kB\n' > "$MEMINFO"
: > "$T/swaps"; SWAPS="$T/swaps" inst "${REPO[@]}" --dry-run; check "2 ГБ без флагов → облегчённый режим и swap включены автоматически, в плане видно" '[[ "$RC" == 0 ]] && grep -q "выбран автоматически" "$T/out.log" && grep -q "будет создан файл" "$T/out.log"'
SWAPS="$T/swaps" inst "${REPO[@]}" --dry-run --low-memory; check "2 ГБ с --low-memory → план показан, режим назван" '[[ "$RC" == 0 ]] && grep -q "ОБЛЕГЧЁННЫЙ" "$T/out.log" && grep -q "Swap:             не изменяется" "$T/out.log"'
setup; printf 'MemTotal:        1000000 kB\n' > "$MEMINFO"; inst "${REPO[@]}" --dry-run --low-memory
check "1 ГБ отказ даже в облегчённом режиме" '[[ "$RC" != 0 ]] && grep -q "даже для облегчённого" "$T/out.log"'
setup; inst "${REPO[@]}" --dry-run --swap-size abc; check "--swap-size: не число → ошибка" '[[ "$RC" != 0 ]]'
inst "${REPO[@]}" --dry-run --swap-size 64; check "--swap-size: слишком мало → ошибка" '[[ "$RC" != 0 ]]'

# установка в облегчённом режиме: лимиты в compose/.env, swap создаётся ТОЛЬКО по флагу (команды подменены через PATH)
mkstubs() { mkdir -p "$T/bin"; for c in dd mkswap swapon; do printf '#!/usr/bin/env bash\necho "%s $*" >> "%s"\n' "$c" "$T/swap.log" > "$T/bin/$c"; chmod +x "$T/bin/$c"; done
  # поддельный dd, как настоящий, создаёт выходной файл (без записи гигабайтов)
  printf '#!/usr/bin/env bash\necho "dd $*" >> "%s"\nfor a in "$@"; do [[ "$a" == of=* ]] && : > "${a#of=}"; done\nexit 0\n' "$T/swap.log" > "$T/bin/dd"; chmod +x "$T/bin/dd"; }
setup; printf 'MemTotal:        2015000 kB\n' > "$MEMINFO"; mkstubs; : > "$T/swaps"; : > "$T/fstab"
PATH="$T/bin:$PATH" SWAPS="$T/swaps" FSTAB="$T/fstab" SWAPFILE="$T/swapfile" inst "${REPO[@]}" --yes --low-memory
check "low-memory: установка успешна, лимиты записаны в compose/.env" '[[ "$RC" == 0 ]] && [[ "$(val "$SM_ROOT/compose/.env" SM_MEM_POSTGRES)" == 320m ]] && [[ "$(val "$SM_ROOT/compose/.env" SM_PG_MAX_CONNECTIONS)" == 30 ]] && [[ "$(val "$SM_ROOT/compose/.env" SM_WEB_NODE_OPTIONS)" == --max-old-space-size=160 ]]'
check "без --swap-size swap не создаётся и fstab не тронут" '[[ ! -e "$T/swap.log" && ! -s "$T/fstab" ]]'
setup; mkstubs; : > "$T/swaps"; : > "$T/fstab"
PATH="$T/bin:$PATH" SWAPS="$T/swaps" FSTAB="$T/fstab" SWAPFILE="$T/swapfile" inst "${REPO[@]}" --yes --swap-size 2048
check "обычный режим: лимиты не записываются" '[[ "$RC" == 0 ]] && [[ -z "$(val "$SM_ROOT/compose/.env" SM_MEM_POSTGRES)" ]]'
check "--swap-size: dd/mkswap/swapon вызваны, fstab дополнен" 'grep -q "count=2048" "$T/swap.log" && grep -q "^mkswap" "$T/swap.log" && grep -q "^swapon" "$T/swap.log" && grep -q "$T/swapfile none swap" "$T/fstab"'
setup; mkstubs; printf 'Filename Type Size Used Priority\n/dev/x partition 1000 0 -2\n' > "$T/swaps"; : > "$T/fstab"
PATH="$T/bin:$PATH" SWAPS="$T/swaps" FSTAB="$T/fstab" SWAPFILE="$T/swapfile" inst "${REPO[@]}" --yes --swap-size 2048
check "swap уже подключён → второй не создаётся" '[[ "$RC" == 0 ]] && [[ ! -e "$T/swap.log" ]] && grep -q "swap уже подключён" "$T/out.log"'
setup; mkstubs; : > "$T/swaps"; : > "$T/fstab"
PATH="$T/bin:$PATH" SWAPS="$T/swaps" FSTAB="$T/fstab" SWAPFILE="$T/swapfile" inst "${REPO[@]}" --dry-run --swap-size 2048
check "dry-run со swap: ничего не создано, fstab пуст, план упоминает файл" '[[ "$RC" == 0 ]] && [[ ! -e "$T/swap.log" && ! -s "$T/fstab" ]] && grep -q "будет создан файл" "$T/out.log"'

echo "== 9. администратор платформы (PLATFORM_ADMIN_EMAILS)"
setup; inst "${REPO[@]}" --yes --create-owner boss@example.com
check "--create-owner назначает администратора платформы" '[[ "$RC" == 0 ]] && grep -qx '"'"'PLATFORM_ADMIN_EMAILS=\["boss@example.com"\]'"'"' "$SM_ROOT/env/api.env" && [[ "$(stat -c %a "$SM_ROOT/env/api.env")" == 600 ]]'
setup; inst "${REPO[@]}" --yes --create-owner boss@example.com --platform-admin root@example.com
check "--platform-admin важнее --create-owner" 'grep -qx '"'"'PLATFORM_ADMIN_EMAILS=\["root@example.com"\]'"'"' "$SM_ROOT/env/api.env"'
inst "${REPO[@]}" --yes --platform-admin another@example.com
check "повторный запуск не перезаписывает выбор владельца" '[[ "$(grep -c "^PLATFORM_ADMIN_EMAILS=" "$SM_ROOT/env/api.env")" == 1 ]] && grep -q "root@example.com" "$SM_ROOT/env/api.env" && grep -q "уже задан" "$T/out.log"'
setup; inst "${REPO[@]}" --yes
check "без флагов администратор не назначается" '[[ "$RC" == 0 ]] && ! grep -q "^PLATFORM_ADMIN_EMAILS=" "$SM_ROOT/env/api.env"'
setup; inst "${REPO[@]}" --dry-run --platform-admin a@example.com
check "dry-run показывает администратора и ничего не пишет" '[[ "$RC" == 0 ]] && grep -q "Администратор:    a@example.com" "$T/out.log" && [[ ! -e "$SM_ROOT/env/api.env" ]]'
for bad in 'x"y@example.com' 'a b@example.com' 'no-at.example.com' 'a@b'; do
  setup; inst "${REPO[@]}" --dry-run --platform-admin "$bad"
  check "некорректный email администратора отвергается: $bad" '[[ "$RC" != 0 ]] && grep -q "platform-admin" "$T/out.log"'
done

echo
echo "install.sh: пройдено $PASS, провалено $FAILN"
[[ "$FAILN" == 0 ]]
