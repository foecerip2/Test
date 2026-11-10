#!/usr/bin/env bash
# LeadHunter — настройка сервера на самом сервере, БЕЗ передачи секретов в чат.
# Ставится как /usr/local/sbin/lh-config (установщик; затем обновляется службой lh-update). Запускать от root.
#
#   lh-config smtp                    — интерактивно: SMTP-сервер, порт, шифрование, логин, пароль (скрытый ввод), «от кого»
#   lh-config smtp-test you@mail.ru   — отправить тестовое письмо через api
#   lh-config owner you@mail.ru       — e-mail владельца (его регистрация одобряется автоматически)
#   lh-config show                    — текущие настройки (секреты замаскированы)
#   lh-config restart                 — пересоздать контейнер api (применить .env)
#   lh-config gate on|off             — включить/выключить необязательный пароль-шлюз basic-auth перед сайтом
#   lh-config init [--domain D]       — создать недостающие значения в .env (секреты генерируются; существующие не трогаются)
set -euo pipefail

APP="${LH_APP:-/opt/leadhunter}"
ENVF="$APP/.env"

die() { printf 'ОШИБКА: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || [ -n "${LH_APP:-}" ] || die "Запустите от root"
[ -d "$APP" ] || die "Каталог $APP не найден"

compose() { docker compose --env-file "$ENVF" -f "$APP/docker-compose.prod.yml" "$@"; }

lock() { exec 8>"$APP/.env.lock"; flock -w 30 8 || die "Не удалось получить блокировку .env"; }

# ── .env: чтение и атомарная запись ────────────────────────────────────────────
get_kv() {   # значение без экранирования ($$ → $)
  local line; line="$(grep -E "^$1=" "$ENVF" 2>/dev/null | head -1 || true)"
  line="${line#*=}"; printf '%s' "${line//\$\$/\$}"
}

set_kv() {   # $1 = ключ, $2 = «сырое» значение; для compose знак $ удваивается
  local k="$1" v="$2" tmp
  [[ "$k" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "Некорректное имя переменной"
  if [[ "$v" =~ [[:cntrl:]] ]]; then die "Значение содержит перевод строки или управляющий символ"; fi
  tmp="$(mktemp "$APP/.env.XXXXXX")"; chmod 0600 "$tmp"
  V="${v//\$/\$\$}" awk -v k="$k" 'BEGIN{d=0} index($0,k"=")==1{print k"="ENVIRON["V"]; d=1; next} {print} END{if(!d)print k"="ENVIRON["V"]}' "$ENVF" > "$tmp" \
    || { rm -f "$tmp"; die "Не удалось обновить .env"; }
  mv -f "$tmp" "$ENVF"
}

# ── валидаторы ─────────────────────────────────────────────────────────────────
valid_email() { [ "${#1}" -le 254 ] && [[ "$1" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$ ]]; }
valid_host()  { [ "${#1}" -le 253 ] && [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; }
valid_port()  { [[ "$1" =~ ^[0-9]{1,5}$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }
valid_login() { [ "${#1}" -le 254 ] && [[ "$1" =~ ^[A-Za-z0-9._%+@-]+$ ]]; }
valid_from()  {
  valid_email "$1" && return 0
  [ "${#1}" -le 200 ] || return 1
  [[ "$1" =~ ^[^[:cntrl:]\<\>\"\'\\\$#]+\ \<[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\>$ ]]
}
valid_secret() {   # пароль: без управляющих символов, без пробелов по краям, без « #», не начинается с кавычки
  [ "${#1}" -ge 1 ] && [ "${#1}" -le 200 ] || return 1
  [[ "$1" =~ [[:cntrl:]] ]] && return 1
  [[ "$1" =~ ^[[:space:]] || "$1" =~ [[:space:]]$ ]] && return 1
  [[ "$1" == *" #"* ]] && return 1
  [[ "$1" == \"* || "$1" == \'* ]] && return 1
  return 0
}

restart_api() {
  [ "$(get_kv COMPOSE_PROFILES)" = "api" ] || die "api не включён (в .env нет COMPOSE_PROFILES=api): сначала должна пройти установка/обновление"
  compose up -d --no-deps --force-recreate api
}

ask() {   # ask "Вопрос" [по-умолчанию] → ответ в REPLY
  local def="${2:-}"
  if [ -n "$def" ]; then read -r -p "$1 [$def]: " REPLY || { REPLY="$def"; return 1; }; REPLY="${REPLY:-$def}"
  else read -r -p "$1: " REPLY || { REPLY=""; return 1; }; fi
}

# ── команды ────────────────────────────────────────────────────────────────────
cmd_smtp() {
  say "Настройка почты (SMTP) для кодов подтверждения. Пароль вводится скрыто и нигде не печатается."
  local sec host port user pass pass2 from defport
  while :; do ask "Шифрование (ssl = порт 465, starttls = порт 587)" "$(get_kv SMTP_SECURITY)" || die "Ввод прерван"; sec="${REPLY:-ssl}"
    case "$sec" in ssl|starttls) break ;; *) say "Допустимо: ssl или starttls" ;; esac
  done
  while :; do ask "SMTP-сервер (host)" "$(get_kv SMTP_HOST)" || die "Ввод прерван"; host="$REPLY"
    valid_host "$host" && break; say "Некорректное имя сервера (только латиница, цифры, точка, дефис)"
  done
  defport=465; [ "$sec" = starttls ] && defport=587
  while :; do ask "Порт" "$defport" || die "Ввод прерван"; port="$REPLY"
    valid_port "$port" && break; say "Порт — число 1..65535"
  done
  while :; do ask "Логин (обычно полный адрес ящика)" "$(get_kv SMTP_USER)" || die "Ввод прерван"; user="$REPLY"
    valid_login "$user" && break; say "Некорректный логин"
  done
  while :; do
    read -rsp "Пароль ящика (ввод скрыт): " pass || die "Ввод прерван"; echo
    read -rsp "Повторите пароль: " pass2 || die "Ввод прерван"; echo
    [ "$pass" = "$pass2" ] || { say "Пароли не совпадают"; continue; }
    valid_secret "$pass" && break
    say "Пароль не подходит для записи в .env (нет управляющих символов, пробелов по краям, ' #', кавычки в начале). Смените пароль ящика."
  done
  while :; do ask "От кого (адрес отправителя)" "$user" || die "Ввод прерван"; from="$REPLY"
    valid_from "$from" && break; say "Нужен адрес вида noreply@vaylonet.ru или Имя <noreply@vaylonet.ru>"
  done
  lock
  set_kv SMTP_HOST "$host"; set_kv SMTP_PORT "$port"; set_kv SMTP_SECURITY "$sec"
  set_kv SMTP_USER "$user"; set_kv SMTP_PASSWORD "$pass"; set_kv SMTP_FROM "$from"; set_kv MAIL_BACKEND smtp
  chmod 0600 "$ENVF"
  say "Сохранено в $ENVF (права 0600). Пароль не показывается."
  ask "Применить сейчас (пересоздать api)? y/n" "y" || true
  if [ "$REPLY" = y ] || [ "$REPLY" = Y ]; then restart_api; fi
  ask "Отправить тестовое письмо? Введите адрес получателя или оставьте пустым" "" || true
  if [ -n "$REPLY" ]; then cmd_smtp_test "$REPLY"; else say "Позже: lh-config smtp-test you@example.com"; fi
}

cmd_smtp_test() {
  local to="${1:-}"
  valid_email "$to" || die "Укажите корректный адрес: lh-config smtp-test you@example.com"
  say "Отправка тестового письма на $to ..."
  if compose exec -T api python -m app.cli send-test-mail "$to"; then
    say "Команда выполнена. Проверьте ящик (и папку «Спам»)."
  else
    die "Не удалось отправить. Логи: docker compose --env-file $ENVF -f $APP/docker-compose.prod.yml logs --tail 50 api"
  fi
}

cmd_owner() {
  local e="${1:-}"
  valid_email "$e" || die "Укажите корректный адрес: lh-config owner you@example.com"
  lock; set_kv OWNER_EMAIL "$e"
  say "OWNER_EMAIL = $e"
  restart_api
}

mask() { if [ -n "$1" ]; then printf '***задан***'; else printf '(не задан)'; fi; }

cmd_show() {
  local k db gate
  for k in DOMAIN PUBLIC_ORIGIN COOKIE_SECURE OWNER_EMAIL MAIL_BACKEND SMTP_HOST SMTP_PORT SMTP_SECURITY SMTP_USER SMTP_FROM; do
    printf '%-16s %s\n' "$k" "$(get_kv "$k")"
  done
  for k in SMTP_PASSWORD SECRET_KEY POSTGRES_PASSWORD; do printf '%-16s %s\n' "$k" "$(mask "$(get_kv "$k")")"; done
  db="$(get_kv DATABASE_URL)"; printf '%-16s %s\n' DATABASE_URL "$(sed -E 's|(://[^:/@]+):[^@]*@|\1:***@|' <<<"$db")"
  if [ -n "$(get_kv BASIC_HASH)" ]; then gate="включён (логин $(get_kv BASIC_USER))"; else gate="выключен"; fi
  printf '%-16s %s\n' "Шлюз (basic)" "$gate"
  for k in COMPOSE_PROFILES WEB_IMAGE API_IMAGE; do printf '%-16s %s\n' "$k" "$(get_kv "$k")"; done
  if [ -z "$(get_kv SMTP_HOST)" ]; then say; say "Почта не настроена: регистрация отвечает 503 MAIL_UNAVAILABLE. Выполните: lh-config smtp"; fi
}

cmd_gate() {
  case "${1:-}" in
    on)
      local p p2 hash
      while :; do
        read -rsp "Пароль шлюза (скрыт): " p || die "Ввод прерван"; echo
        read -rsp "Повторите: " p2 || die "Ввод прерван"; echo
        if [ "$p" = "$p2" ] && valid_secret "$p"; then break; fi; say "Пароли не совпадают или недопустимы"
      done
      [ -f "$APP/caddy/gate.on.caddy" ] || die "Нет $APP/caddy/gate.on.caddy (появится после первого обновления)"
      hash="$(docker run --rm caddy:2.8-alpine caddy hash-password --plaintext "$p")"
      lock; set_kv BASIC_USER owner; set_kv BASIC_HASH "$hash"
      install -m 0644 "$APP/caddy/gate.on.caddy" "$APP/caddy/gate.caddy" ;;
    off)
      [ -f "$APP/caddy/gate.off.caddy" ] || die "Нет $APP/caddy/gate.off.caddy (появится после первого обновления)"
      lock; set_kv BASIC_HASH ""
      install -m 0644 "$APP/caddy/gate.off.caddy" "$APP/caddy/gate.caddy" ;;
    *) die "Использование: lh-config gate on|off" ;;
  esac
  compose up -d --no-deps --force-recreate caddy
  say "Шлюз: $1"
}

rand_hex() { openssl rand -hex "$1"; }

cmd_init() {
  local domain="" d pg k
  while [ $# -gt 0 ]; do case "$1" in --domain) domain="${2:-}"; shift 2 ;; *) die "Неизвестный аргумент: $1" ;; esac; done
  [ -f "$ENVF" ] || install -m 0600 /dev/null "$ENVF"
  lock
  fill() { [ -n "$(get_kv "$1")" ] || set_kv "$1" "$2"; }
  if [ -n "$domain" ]; then fill DOMAIN "$domain"; fi
  d="$(get_kv DOMAIN)"
  if [ -n "$d" ]; then fill PUBLIC_ORIGIN "https://$d"; fi
  fill POSTGRES_PASSWORD "$(rand_hex 24)"; pg="$(get_kv POSTGRES_PASSWORD)"
  # драйвер должен совпадать с зависимостями apps/api (psycopg 3); при расхождении поправьте DATABASE_URL
  fill DATABASE_URL "postgresql+psycopg://leadhunter:${pg}@db:5432/leadhunter"
  fill SECRET_KEY "$(rand_hex 32)"
  fill COOKIE_SECURE true
  # console-почта в prod запрещена: пока SMTP не задан, api отвечает 503 MAIL_UNAVAILABLE
  if [ -z "$(get_kv MAIL_BACKEND)" ] || [ "$(get_kv MAIL_BACKEND)" = console ]; then set_kv MAIL_BACKEND smtp; fi
  fill SMTP_SECURITY ssl
  for k in OWNER_EMAIL SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASSWORD SMTP_FROM BASIC_HASH WEB_IMAGE API_IMAGE; do
    grep -qE "^$k=" "$ENVF" || set_kv "$k" ""
  done
  fill BASIC_USER owner
  chmod 0600 "$ENVF"
  say "Конфигурация .env дополнена (существующие значения не изменены)."
}

case "${1:-}" in
  smtp) cmd_smtp ;;
  smtp-test) shift; cmd_smtp_test "${1:-}" ;;
  owner) shift; cmd_owner "${1:-}" ;;
  show) cmd_show ;;
  restart) restart_api ;;
  gate) shift; cmd_gate "${1:-}" ;;
  init) shift; cmd_init "$@" ;;
  *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
