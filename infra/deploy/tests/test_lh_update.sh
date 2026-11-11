#!/usr/bin/env bash
# Сценарная проверка lh-update и lh-config на подставных git / docker / GitHub API (python http.server).
# Реальный Docker, сеть и GitHub не нужны. Запуск:  bash infra/deploy/tests/test_lh_update.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
T="$(mktemp -d)"
trap 'kill "${SRV_PID:-0}" 2>/dev/null || true; rm -rf "$T"' EXIT

APP="$T/opt"; BIN="$T/bin"; SBIN="$T/sbin"; GH="$T/gh"; D="$T/docker"; CTL="$T/ctl"; FIX="$T/fixture"
mkdir -p "$APP" "$BIN" "$SBIN" "$GH/repos/o/r/commits" "$D/images" "$CTL" "$FIX"

# ── фикстура «исходников»: реальные файлы инфраструктуры + web Dockerfile ──────
mkdir -p "$FIX/infra/deploy" "$FIX/apps/web"
cp -r "$REPO_ROOT/infra/caddy" "$REPO_ROOT/infra/compose" "$FIX/infra/"
cp "$REPO_ROOT/infra/deploy/lh-update.sh" "$REPO_ROOT/infra/deploy/lh-config.sh" "$FIX/infra/deploy/"
cp "$REPO_ROOT/apps/web/Dockerfile" "$FIX/apps/web/Dockerfile"

# ── shim: git ──────────────────────────────────────────────────────────────────
cat > "$BIN/git" <<'EOF'
#!/usr/bin/env bash
dir=""; if [ "$1" = "-C" ]; then dir="$2"; shift 2; fi
case "$1" in
  clone) for a; do last="$a"; done; mkdir -p "$last/.git" ;;
  fetch) echo "$4" > "$dir/.git/FETCHED" ;;
  checkout)
    sha="${@: -1}"
    find "$dir" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
    cp -a "$LH_TEST_FIXTURE/." "$dir/"
    if [ -f "$LH_TEST_CTL/api_present" ]; then mkdir -p "$dir/apps/api"; echo "FROM scratch" > "$dir/apps/api/Dockerfile"; fi
    if [ -f "$LH_TEST_CTL/af_present" ]; then mkdir -p "$dir/apps/autoflow-web"; echo "FROM scratch" > "$dir/apps/autoflow-web/Dockerfile"; fi
    echo "$sha" > "$dir/.git/SHA" ;;
  rev-parse) cat "$dir/.git/SHA" ;;
  *) echo "git shim: неизвестная команда $*" >&2; exit 1 ;;
esac
EOF

# ── shim: docker (build / image / inspect / compose) ───────────────────────────
cat > "$BIN/docker" <<'EOF'
#!/usr/bin/env bash
D="$LH_TEST_DOCKER"; CTL="$LH_TEST_CTL"
echo "docker $*" >> "$D/docker.log"
img_file() { echo "$D/images/${1//[:\/]/__}"; }
case "$1" in
  build)
    tag=""; file=""; while [ $# -gt 0 ]; do case "$1" in -t) tag="$2"; shift 2 ;; -f) file="$2"; shift 2 ;; *) shift ;; esac; done
    svc=web; case "$file" in */apps/api/Dockerfile) svc=api ;; */apps/autoflow-web/Dockerfile) svc=autoflow ;; esac
    if [ -f "$CTL/fail_build_$svc" ]; then echo "ERROR: build $svc failed (подстановка)" >&2; exit 1; fi
    n=$(( $(cat "$D/seq" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$D/seq"; echo "$n" > "$(img_file "$tag")"
    echo "built $tag from $file" ;;
  image)
    case "$2" in
      inspect) [ -f "$(img_file "$3")" ] ;;
      ls) repo="$3"; for f in "$D"/images/"${repo}"__*; do [ -f "$f" ] || continue; echo "$(cat "$f") $(basename "$f" | sed 's/__/:/')"; done | sort -rn | awk '{print $2}' ;;
    esac ;;
  rmi) for i in "$@"; do [ "$i" = rmi ] || rm -f "$(img_file "$i")"; done ;;
  builder) : ;;
  inspect)
    cid="${@: -1}"; img=""
    [ "$cid" = web ] && img="$(cat "$D/running_web" 2>/dev/null)"; [ "$cid" = api ] && img="$(cat "$D/running_api" 2>/dev/null)"
    [ "$cid" = autoflow-web ] && img="$(cat "$D/running_autoflow" 2>/dev/null)"
    if grep -qxF "$img" "$CTL/bad_images" 2>/dev/null; then echo unhealthy; else echo healthy; fi ;;
  compose)
    shift; envf=""; while [ $# -gt 0 ]; do case "$1" in --env-file) envf="$2"; shift 2 ;; -f) shift 2 ;; *) break ;; esac; done
    sub="$1"; shift
    genv() { grep -E "^$1=" "$envf" | head -1 | cut -d= -f2-; }
    case "$sub" in
      up) case " $* " in *" caddy "*) echo "UP caddy args: $*"; exit 0 ;; esac   # точечное пересоздание caddy не меняет web/api/autoflow
          genv WEB_IMAGE > "$D/running_web"
          case ",$(genv COMPOSE_PROFILES)," in *,api,*) genv API_IMAGE > "$D/running_api" ;; *) rm -f "$D/running_api" ;; esac
          case ",$(genv COMPOSE_PROFILES)," in *,autoflow,*) genv AUTOFLOW_IMAGE > "$D/running_autoflow" ;; *) rm -f "$D/running_autoflow" ;; esac
          echo "UP web=$(cat "$D/running_web") api=$(cat "$D/running_api" 2>/dev/null) autoflow=$(cat "$D/running_autoflow" 2>/dev/null) args: $*" ;;
      ps) [ "$2" = web ] && [ -s "$D/running_web" ] && echo web; [ "$2" = api ] && [ -s "$D/running_api" ] && echo api
          [ "$2" = autoflow-web ] && [ -s "$D/running_autoflow" ] && echo autoflow-web; true ;;
      stop|rm) echo "compose $sub $*"; [ "${*: -1}" = autoflow-web ] && [ "$sub" = stop ] && rm -f "$D/running_autoflow"; true ;;
      restart|exec) echo "compose $sub $*" ;;
    esac ;;
  run) if [ "${LH_CADDY_INVALID:-0}" = 1 ] && printf '%s ' "$@" | grep -q 'caddy validate'; then exit 1; fi
       echo '$2a$14$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345' ;;
esac
exit 0
EOF
chmod +x "$BIN/git" "$BIN/docker"

# ── подставной GitHub API ──────────────────────────────────────────────────────
PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$GH" >/dev/null 2>&1 &
SRV_PID=$!
for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && break; sleep 0.1; done

mksha() { printf '%s' "$1" | sha1sum | cut -c1-40; }
set_head() {   # $1 = sha, $2 = состояние CI: success | failure | pending | none
  printf '{"sha":"%s"}' "$1" > "$GH/repos/o/r/commits/main"
  mkdir -p "$GH/repos/o/r/commits/$1"
  case "$2" in
    success) echo '{"check_runs":[{"name":"test","status":"completed","conclusion":"success"}]}' ;;
    failure) echo '{"check_runs":[{"name":"test","status":"completed","conclusion":"failure"}]}' ;;
    pending) echo '{"check_runs":[{"name":"test","status":"in_progress","conclusion":null}]}' ;;
    *) echo '{"check_runs":[]}' ;;
  esac > "$GH/repos/o/r/commits/$1/check-runs"
}

printf 'REPO=o/r\nBRANCH=main\n' > "$APP/lh.conf"
printf 'DOMAIN=example.test\nBASIC_USER=owner\nBASIC_HASH=\nWEB_IMAGE=\n' > "$APP/.env"; chmod 600 "$APP/.env"

export LH_TEST_FIXTURE="$FIX" LH_TEST_CTL="$CTL" LH_TEST_DOCKER="$D"
run_update() {   # $@ = аргументы lh-update; вывод в $OUT
  OUT="$(PATH="$BIN:$PATH" LH_APP="$APP" LH_SELF="$SBIN/lh-update" LH_CONFIG_BIN="$SBIN/lh-config" \
    LH_API="http://127.0.0.1:$PORT" LH_GIT_URL=none LH_HEALTH_TRIES=2 LH_HEALTH_SLEEP=0 \
    bash "$REPO_ROOT/infra/deploy/lh-update.sh" "$@" 2>&1)"
  printf '%s\n' "$OUT" | sed 's/^/    | /'
}
genv() { grep -E "^$1=" "$APP/.env" | head -1 | cut -d= -f2- || true; }
rf() { cat "$APP/$1" 2>/dev/null || true; }

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$1"; }
eq()   { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (получено «$2», ожидалось «$3»)"; fi; }
has()  { if grep -qF -- "$2" <<<"$OUT"; then ok "$1"; else bad "$1 (в выводе нет «$2»)"; fi; }
hasnt(){ if grep -qF -- "$2" <<<"$OUT"; then bad "$1 (в выводе есть «$2»)"; else ok "$1"; fi; }
section() { printf '\n== %s\n' "$1"; }
builds() { grep -c '^docker build -t' "$D/docker.log" 2>/dev/null || true; }
reset_log() { : > "$D/docker.log"; }
dlog_has() { if grep -q -- "$2" "$D/docker.log"; then ok "$1"; else bad "$1 (в docker.log нет «$2»)"; fi; }

S1="$(mksha 1)"; S2="$(mksha 2)"; S3="$(mksha 3)"; S4="$(mksha 4)"; S5="$(mksha 5)"; S6="$(mksha 6)"; S7="$(mksha 7)"

section "1. Нет релиза (нет check-run), красный CI, CI ещё идёт"
reset_log
set_head "$S1" none;    run_update; has "нет check-run: пропуск" "пропуск"; eq "сборок нет" "$(builds)" 0
set_head "$S1" failure; run_update; has "красный CI: пропуск" "test = completed:failure"; eq "сборок нет" "$(builds)" 0
set_head "$S1" pending; run_update; has "CI идёт: пропуск" "test = in_progress:"; eq "сборок нет" "$(builds)" 0

section "2. Пауза"
touch "$APP/.paused"; set_head "$S1" success; run_update; has "пауза" "на паузе"; eq "сборок нет" "$(builds)" 0
rm -f "$APP/.paused"

section "3. Первый выкат без apps/api/Dockerfile: только web"
reset_log; set_head "$S1" success; run_update
has "сообщение про отсутствие api" "apps/api/Dockerfile нет"
eq "WEB_IMAGE" "$(genv WEB_IMAGE)" "lh-web:${S1:0:12}"
eq "COMPOSE_PROFILES не задан" "$(genv COMPOSE_PROFILES)" ""
eq "собран 1 образ" "$(builds)" 1
eq ".last_good" "$(rf .last_good)" "lh-web:${S1:0:12}"
eq ".last_good_api пуст" "$(rf .last_good_api)" ""
eq "gate.caddy = off (BASIC_HASH пуст)" "$(cat "$APP/caddy/gate.caddy")" "$(cat "$APP/caddy/gate.off.caddy")"
[ -f "$APP/caddy/Caddyfile" ] && ok "Caddyfile в каталоге caddy/" || bad "нет caddy/Caddyfile"
dlog_has "caddy перезапущен (конфигурация появилась)" "compose --env-file $APP/.env -f $APP/docker-compose.prod.yml restart caddy"
cmp -s "$REPO_ROOT/infra/deploy/lh-update.sh" "$SBIN/lh-update" && ok "самообновление lh-update" || bad "lh-update не обновлён"
cmp -s "$REPO_ROOT/infra/deploy/lh-config.sh" "$SBIN/lh-config" && ok "lh-config установлен из checkout" || bad "lh-config не установлен"

section "4. Повторный запуск на том же коммите — ничего не делает"
reset_log; run_update; eq "сборок нет" "$(builds)" 0

section "5. Новый коммит с api: два образа, секреты сгенерированы, оба здоровы"
touch "$CTL/api_present"; reset_log; set_head "$S2" success; run_update
eq "WEB_IMAGE" "$(genv WEB_IMAGE)" "lh-web:${S2:0:12}"
eq "API_IMAGE" "$(genv API_IMAGE)" "lh-api:${S2:0:12}"
eq "COMPOSE_PROFILES" "$(genv COMPOSE_PROFILES)" "api"
eq "собрано 2 образа" "$(builds)" 2
eq ".last_good_api" "$(rf .last_good_api)" "lh-api:${S2:0:12}"
eq ".prev_good (web)" "$(rf .prev_good)" "lh-web:${S1:0:12}"
[ -n "$(genv POSTGRES_PASSWORD)" ] && [ -n "$(genv SECRET_KEY)" ] && ok "секреты сгенерированы" || bad "нет секретов"
sk="$(genv SECRET_KEY)"; eq "длина SECRET_KEY" "${#sk}" 64
eq "PUBLIC_ORIGIN" "$(genv PUBLIC_ORIGIN)" "https://example.test"
eq "MAIL_BACKEND" "$(genv MAIL_BACKEND)" "smtp"
dlog_has "контекст сборки api = apps/api" "/apps/api/Dockerfile $APP/src/apps/api"

section "6. Новый коммит: api нездоров -> откат на оба прежних образа"
reset_log; echo "lh-api:${S3:0:12}" > "$CTL/bad_images"; set_head "$S3" success; run_update
has "лог провала" "Проверка здоровья не пройдена"
has "лог отката" "Автоматический откат"
eq "WEB_IMAGE откатан" "$(genv WEB_IMAGE)" "lh-web:${S2:0:12}"
eq "API_IMAGE откатан" "$(genv API_IMAGE)" "lh-api:${S2:0:12}"
eq ".failed_sha" "$(rf .failed_sha)" "$S3"
eq ".last_good не тронут" "$(rf .last_good)" "lh-web:${S2:0:12}"
reset_log; run_update; eq "провалившийся коммит не пробуется снова" "$(builds)" 0
: > "$CTL/bad_images"

section "7. Новый коммит: web нездоров (api в порядке) -> откат на оба"
echo "lh-web:${S4:0:12}" > "$CTL/bad_images"; set_head "$S4" success; run_update
eq "WEB_IMAGE откатан" "$(genv WEB_IMAGE)" "lh-web:${S2:0:12}"
eq "API_IMAGE откатан" "$(genv API_IMAGE)" "lh-api:${S2:0:12}"
eq ".failed_sha" "$(rf .failed_sha)" "$S4"
: > "$CTL/bad_images"

section "8. Сбой сборки api / web"
touch "$CTL/fail_build_api"; set_head "$S5" success; run_update
has "сбой сборки api" "Сборка api не удалась"; eq ".failed_sha" "$(rf .failed_sha)" "$S5"; eq "WEB_IMAGE не менялся" "$(genv WEB_IMAGE)" "lh-web:${S2:0:12}"
rm -f "$CTL/fail_build_api"; touch "$CTL/fail_build_web"; set_head "$S6" success; run_update
has "сбой сборки web" "Сборка web не удалась"; eq ".failed_sha" "$(rf .failed_sha)" "$S6"; eq "API_IMAGE не менялся" "$(genv API_IMAGE)" "lh-api:${S2:0:12}"
rm -f "$CTL/fail_build_web"

section "9. Успешный выкат с включённым шлюзом (BASIC_HASH), затем ручной откат"
sed -i 's|^BASIC_HASH=.*|BASIC_HASH=$$2a$$14$$hash|' "$APP/.env"
set_head "$S7" success; run_update
eq "WEB_IMAGE" "$(genv WEB_IMAGE)" "lh-web:${S7:0:12}"
eq "API_IMAGE" "$(genv API_IMAGE)" "lh-api:${S7:0:12}"
eq ".prev_good" "$(rf .prev_good)" "lh-web:${S2:0:12}"
eq ".prev_good_api" "$(rf .prev_good_api)" "lh-api:${S2:0:12}"
eq "gate.caddy = on (BASIC_HASH задан)" "$(cat "$APP/caddy/gate.caddy")" "$(cat "$APP/caddy/gate.on.caddy")"
run_update --rollback
has "ручной откат" "Откат выполнен"
eq "WEB_IMAGE после отката" "$(genv WEB_IMAGE)" "lh-web:${S2:0:12}"
eq "API_IMAGE после отката" "$(genv API_IMAGE)" "lh-api:${S2:0:12}"
eq ".failed_sha = откатанный" "$(rf .failed_sha)" "$S7"
reset_log; run_update; eq "откатанный коммит не выкатывается" "$(builds)" 0

section "10. Чистка образов: не больше 3 (+ запущенные) на репозиторий"
cnt_web="$(find "$D/images" -name 'lh-web__*' | wc -l)"; cnt_api="$(find "$D/images" -name 'lh-api__*' | wc -l)"
if [ "$cnt_web" -le 4 ] && [ "$cnt_api" -le 4 ]; then ok "образов web=$cnt_web api=$cnt_api"; else bad "чистка: web=$cnt_web api=$cnt_api"; fi

# ── lh-config ──────────────────────────────────────────────────────────────────
section "11. lh-config"
cfg() { PATH="$BIN:$PATH" LH_APP="$APP" bash "$REPO_ROOT/infra/deploy/lh-config.sh" "$@" 2>&1; }
OUT="$(cfg owner 'bad@x.ru
evil=1')"; has "owner: перевод строки отклонён" "ОШИБКА"
OUT="$(cfg owner 'bad address@x.ru')"; has "owner: пробел отклонён" "ОШИБКА"
reset_log; OUT="$(cfg owner boss@example.com)"; eq "owner записан" "$(genv OWNER_EMAIL)" "boss@example.com"
dlog_has "owner: api пересоздан" "up -d --no-deps --force-recreate api"
PW='p@ss$w0rd#1{x}'
OUT="$(printf 'ssl\nsmtp.example.com\n465\nnoreply@example.com\n%s\n%s\nnoreply@example.com\nn\n\n' "$PW" "$PW" | cfg smtp)"
printf '%s\n' "$OUT" | sed 's/^/    | /'
eq "SMTP_HOST" "$(genv SMTP_HOST)" "smtp.example.com"
eq "SMTP_PORT" "$(genv SMTP_PORT)" "465"
eq "SMTP_PASSWORD записан с \$\$" "$(genv SMTP_PASSWORD)" 'p@ss$$w0rd#1{x}'
eq "права .env 0600" "$(stat -c %a "$APP/.env")" 600
hasnt "пароль не напечатан" "w0rd"
OUT="$(cfg show)"; printf '%s\n' "$OUT" | sed 's/^/    | /'
has "show: секрет замаскирован" "***задан***"; hasnt "show: пароль не виден" "w0rd"; hasnt "show: SECRET_KEY не виден" "$(genv SECRET_KEY)"
OUT="$(printf 'ssl\nsmtp.example.com\n465\nu@example.com\n" bad\n" bad\nq\nq\nq\n' | cfg smtp)"; has "пароль с кавычкой в начале отклонён" "Пароль не подходит"
reset_log; OUT="$(cfg smtp-test t@example.com)"
dlog_has "smtp-test вызывает app.cli send-test-mail" "exec -T api python -m app.cli send-test-mail t@example.com"
OUT="$(cfg smtp-test 'x;rm -rf /')"; has "smtp-test: адрес валидируется" "ОШИБКА"
reset_log; OUT="$(cfg restart)"; dlog_has "restart" "force-recreate api"

section "12. lh-config mail-relay"
OUT="$(printf 'n\n' | cfg mail-relay 'http://vaylonet.ru/x.php')"; has "mail-relay: http:// отклонён" "ОШИБКА"
OUT="$(cfg mail-relay 'https://evil.ru/x y')"; has "mail-relay: пробел в URL отклонён" "ОШИБКА"
OUT="$(cfg mail-relay 'https://user:pw@vaylonet.ru/x.php')"; has "mail-relay: логин в URL отклонён" "ОШИБКА"
eq "MAIL_RELAY_SECRET не создан при ошибке" "$(genv MAIL_RELAY_SECRET)" ""
reset_log; OUT="$(printf '\ny\n' | cfg mail-relay)"; printf '%s\n' "$OUT" | sed -E 's/[0-9a-f]{64}/<СЕКРЕТ>/' | sed 's/^/    | /'
eq "MAIL_BACKEND=http" "$(genv MAIL_BACKEND)" "http"
eq "URL по умолчанию" "$(genv MAIL_RELAY_URL)" "https://vaylonet.ru/lh-mail.php"
RS="$(genv MAIL_RELAY_SECRET)"; eq "секрет 64 hex" "$(printf '%s' "$RS" | grep -cE '^[0-9a-f]{64}$')" 1
has "секрет показан владельцу" "$RS"
has "инструкция про setup.sh" "setup.sh"
eq "права .env 0600" "$(stat -c %a "$APP/.env")" 600
dlog_has "api пересоздан" "force-recreate api"
OUT="$(cfg show)"; printf '%s\n' "$OUT" | sed 's/^/    | /'
has "show: MAIL_RELAY_URL виден" "https://vaylonet.ru/lh-mail.php"
has "show: секрет замаскирован" "MAIL_RELAY_SECRET ***задан***"; hasnt "show: секрет не виден" "$RS"
OUT="$(printf 'n\nn\n' | cfg mail-relay https://relay.example.org/m.php)"
eq "секрет не перегенерирован без согласия" "$(genv MAIL_RELAY_SECRET)" "$RS"
eq "URL обновлён" "$(genv MAIL_RELAY_URL)" "https://relay.example.org/m.php"
hasnt "старый секрет повторно не показан" "$RS"
OUT="$(printf '\ny\nn\n' | cfg mail-relay)"
[ "$(genv MAIL_RELAY_SECRET)" != "$RS" ] && ok "секрет перегенерирован по запросу" || bad "секрет не изменился"
reset_log; OUT="$(cfg smtp-test t@example.com)"
dlog_has "smtp-test работает и в режиме http" "exec -T api python -m app.cli send-test-mail t@example.com"

section "13. Невалидная конфигурация Caddy: выкат отменяется до установки, прежняя версия остаётся"
S8="$(mksha 8)"; reset_log; before_web="$(genv WEB_IMAGE)"; before_gate="$(cat "$APP/caddy/gate.caddy" 2>/dev/null || true)"
set_head "$S8" success; LH_CADDY_INVALID=1 run_update
has "сообщение о непройденной проверке Caddy" "не прошла проверку"
eq ".failed_sha" "$(rf .failed_sha)" "$S8"
eq "образов не собиралось" "$(builds)" "0"
eq "WEB_IMAGE не менялся" "$(genv WEB_IMAGE)" "$before_web"
eq "gate.caddy не тронут" "$(cat "$APP/caddy/gate.caddy" 2>/dev/null || true)" "$before_gate"
if grep -q ' up ' "$D/docker.log"; then bad "compose up не должен вызываться"; else ok "compose up не вызывался"; fi

# ── AutoFlow: третий образ, только когда включён ───────────────────────────────
afenv() { genv "$1"; }
S9="$(mksha 9)"; S10="$(mksha 10)"; S11="$(mksha 11)"; S12="$(mksha 12)"; S13="$(mksha 13)"
gdomain_img() { cat "$D/running_autoflow" 2>/dev/null || true; }

section "14. AutoFlow выключен (AUTOFLOW_DOMAIN пуст): поведение прежнее, третий образ не собирается"
touch "$CTL/af_present"; reset_log; set_head "$S9" success; run_update
eq "собрано 2 образа (web, api)" "$(builds)" 2
eq "AUTOFLOW_IMAGE не задан" "$(genv AUTOFLOW_IMAGE)" ""
eq "COMPOSE_PROFILES = api" "$(genv COMPOSE_PROFILES)" "api"
eq "autoflow.caddy = off" "$(cat "$APP/caddy/autoflow.caddy")" "$(cat "$APP/caddy/autoflow.off.caddy")"
eq "контейнер autoflow не запущен" "$(gdomain_img)" ""
eq ".last_good_af нет" "$(rf .last_good_af)" ""
eq "WEB_IMAGE (новый коммит)" "$(genv WEB_IMAGE)" "lh-web:${S9:0:12}"

section "15. lh-config autoflow: валидация и запись"
OUT="$(cfg autoflow 'bad domain')"; has "домен с пробелом отклонён" "ОШИБКА"
OUT="$(cfg autoflow 'nodot')"; has "домен без точки отклонён" "ОШИБКА"
OUT="$(cfg autoflow 'a.b;rm -rf /')"; has "домен с мусором отклонён" "ОШИБКА"
OUT="$(cfg autoflow 'example.test')"; has "совпадение с основным DOMAIN отклонено" "отдельном домене"
OUT="$(cfg autoflow)"; has "без аргумента: справка" "Использование"
eq "AUTOFLOW_DOMAIN не записан при ошибках" "$(genv AUTOFLOW_DOMAIN)" ""
OUT="$(cfg autoflow Autoflow.Example.Test)"; printf '%s\n' "$OUT" | sed 's/^/    | /'
eq "AUTOFLOW_DOMAIN в нижнем регистре" "$(genv AUTOFLOW_DOMAIN)" "autoflow.example.test"
eq "COMPOSE_PROFILES = api,autoflow" "$(genv COMPOSE_PROFILES)" "api,autoflow"
has "подсказка про DNS" "A-запись"
eq "права .env 0600" "$(stat -c %a "$APP/.env")" 600
OUT="$(cfg autoflow autoflow.example.test)"; eq "повтор идемпотентен" "$(genv COMPOSE_PROFILES)" "api,autoflow"
OUT="$(cfg show)"; has "show: AUTOFLOW_DOMAIN" "autoflow.example.test"
eq "api по-прежнему считается включённым (restart)" "$(reset_log; cfg restart >/dev/null; grep -c 'force-recreate api' "$D/docker.log")" 1

section "16. Дособирающий проход на уже развёрнутом коммите: web+api+autoflow, прежняя «предыдущая» версия не затёрта"
prev_before="$(rf .prev_good)"
reset_log; run_update
eq "собрано 3 образа" "$(builds)" 3
eq "AUTOFLOW_IMAGE" "$(genv AUTOFLOW_IMAGE)" "lh-autoflow:${S9:0:12}"
eq "autoflow запущен" "$(gdomain_img)" "lh-autoflow:${S9:0:12}"
eq ".last_good_af" "$(rf .last_good_af)" "lh-autoflow:${S9:0:12}"
eq "autoflow.caddy = on" "$(cat "$APP/caddy/autoflow.caddy")" "$(cat "$APP/caddy/autoflow.on.caddy")"
eq ".prev_good не затёрт" "$(rf .prev_good)" "$prev_before"
dlog_has "контекст сборки autoflow" "/apps/autoflow-web/Dockerfile $APP/src"
dlog_has "build-arg адреса сайта" "NEXT_PUBLIC_SITE_URL=https://autoflow.example.test"
dlog_has "проверка Caddy получает AUTOFLOW_DOMAIN" "AUTOFLOW_DOMAIN=autoflow.example.test"
dlog_has "caddy перезапущен (подключён сайт AutoFlow)" "restart caddy"
reset_log; run_update; eq "повторный запуск ничего не собирает" "$(builds)" 0

section "17. Новый коммит: autoflow нездоров -> откат всех трёх образов"
reset_log; echo "lh-autoflow:${S10:0:12}" > "$CTL/bad_images"; set_head "$S10" success; run_update
has "лог провала" "Проверка здоровья не пройдена"
eq "WEB_IMAGE откатан" "$(genv WEB_IMAGE)" "lh-web:${S9:0:12}"
eq "API_IMAGE откатан" "$(genv API_IMAGE)" "lh-api:${S9:0:12}"
eq "AUTOFLOW_IMAGE откатан" "$(genv AUTOFLOW_IMAGE)" "lh-autoflow:${S9:0:12}"
eq ".failed_sha" "$(rf .failed_sha)" "$S10"
eq ".last_good_af не тронут" "$(rf .last_good_af)" "lh-autoflow:${S9:0:12}"
: > "$CTL/bad_images"

section "18. Сбой сборки autoflow: ничего не переключается"
touch "$CTL/fail_build_autoflow"; set_head "$S11" success; run_update
has "сообщение" "Сборка autoflow не удалась"; eq ".failed_sha" "$(rf .failed_sha)" "$S11"
eq "WEB_IMAGE не менялся" "$(genv WEB_IMAGE)" "lh-web:${S9:0:12}"
eq "AUTOFLOW_IMAGE не менялся" "$(genv AUTOFLOW_IMAGE)" "lh-autoflow:${S9:0:12}"
rm -f "$CTL/fail_build_autoflow"

section "19. Успешный выкат с AutoFlow и ручной откат на предыдущие три образа"
set_head "$S12" success; run_update
eq "WEB_IMAGE" "$(genv WEB_IMAGE)" "lh-web:${S12:0:12}"
eq "AUTOFLOW_IMAGE" "$(genv AUTOFLOW_IMAGE)" "lh-autoflow:${S12:0:12}"
eq ".prev_good_af" "$(rf .prev_good_af)" "lh-autoflow:${S9:0:12}"
run_update --rollback
has "ручной откат" "Откат выполнен"
eq "WEB_IMAGE после отката" "$(genv WEB_IMAGE)" "lh-web:${S9:0:12}"
eq "API_IMAGE после отката" "$(genv API_IMAGE)" "lh-api:${S9:0:12}"
eq "AUTOFLOW_IMAGE после отката" "$(genv AUTOFLOW_IMAGE)" "lh-autoflow:${S9:0:12}"
eq "autoflow после отката запущен на прежнем образе" "$(gdomain_img)" "lh-autoflow:${S9:0:12}"
eq ".failed_sha = откатанный" "$(rf .failed_sha)" "$S12"

section "20. lh-config autoflow off: контейнер остановлен, Caddy без сайта AutoFlow, LeadHunter не затронут"
reset_log; OUT="$(cfg autoflow off)"; printf '%s\n' "$OUT" | sed 's/^/    | /'
eq "AUTOFLOW_DOMAIN пуст" "$(genv AUTOFLOW_DOMAIN)" ""
eq "COMPOSE_PROFILES = api" "$(genv COMPOSE_PROFILES)" "api"
eq "autoflow.caddy = off" "$(cat "$APP/caddy/autoflow.caddy")" "$(cat "$APP/caddy/autoflow.off.caddy")"
dlog_has "autoflow остановлен" "stop autoflow-web"
dlog_has "caddy пересоздан" "force-recreate caddy"
eq "контейнер autoflow не работает" "$(gdomain_img)" ""
OUT="$(cfg show)"; has "show: AutoFlow выключен" "(выключен)"

section "21. Домен задан, но в коммите нет apps/autoflow-web/Dockerfile: AutoFlow пропускается, остальное работает"
OUT="$(cfg autoflow autoflow.example.test)"; rm -f "$CTL/af_present"
reset_log; set_head "$S13" success; run_update
has "сообщение о пропуске" "AutoFlow пропущен"
eq "собрано 2 образа" "$(builds)" 2
eq "COMPOSE_PROFILES = api" "$(genv COMPOSE_PROFILES)" "api"
eq "autoflow.caddy = off" "$(cat "$APP/caddy/autoflow.caddy")" "$(cat "$APP/caddy/autoflow.off.caddy")"
eq "WEB_IMAGE" "$(genv WEB_IMAGE)" "lh-web:${S13:0:12}"

printf '\nИтог: PASS=%d FAIL=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
