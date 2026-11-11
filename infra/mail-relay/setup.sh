#!/bin/bash
# LeadHunter — установка HTTPS-ретранслятора почты на хостинге Рег.ру (Shell-клиент ISPmanager).
#   curl -fsSL https://raw.githubusercontent.com/foecerip2/Test/main/infra/mail-relay/setup.sh | bash
# Параметры (после «bash -s --»): --webroot ПУТЬ  --url ПОЛНЫЙ_URL
# Безопасно запускать повторно: ничего не удаляется, существующий конфиг по умолчанию сохраняется.
set -eu

RAW_BASE="${LH_RAW_BASE:-https://raw.githubusercontent.com/foecerip2/Test/main/infra/mail-relay}"
WEBROOT=""
URL="https://vaylonet.ru/lh-mail.php"
HOME_DIR="${HOME:?HOME не задан}"

die()  { printf '\nОШИБКА: %s\n' "$*" >&2; exit 1; }
say()  { printf '%s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --webroot) [ $# -ge 2 ] || die "после --webroot нужен путь"; WEBROOT="$2"; shift 2 ;;
    --url)     [ $# -ge 2 ] || die "после --url нужен адрес"; URL="$2"; shift 2 ;;
    *) die "неизвестный параметр: $1" ;;
  esac
done

# ── 1. каталог сайта ───────────────────────────────────────────────────────────
[ -n "$WEBROOT" ] || WEBROOT="$HOME_DIR/www/vaylonet.ru"
if [ ! -d "$WEBROOT" ]; then
  say "Каталог сайта не найден: $WEBROOT"
  say "Посмотрите, какие сайты есть:   ls ~/www"
  say "и запустите снова, указав нужный:"
  say "  curl -fsSL $RAW_BASE/setup.sh | bash -s -- --webroot ~/www/ИМЯ_САЙТА"
  exit 1
fi
WEBROOT="$(cd "$WEBROOT" && pwd -P)"
CONFIG="$(dirname "$WEBROOT")/lh-mail-config.php"
DATA_DIR="$HOME_DIR/lh-mail-data"
command -v curl >/dev/null 2>&1 || die "на хостинге нет curl; скачайте lh-mail.php вручную через Менеджер файлов"
say "Каталог сайта: $WEBROOT"

# ── 2. скрипт ретранслятора ────────────────────────────────────────────────────
TMP="$(mktemp "${TMPDIR:-/tmp}/lh-mail.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
curl -fsSL "$RAW_BASE/lh-mail.php" -o "$TMP" || die "не удалось скачать lh-mail.php"
PHP_BIN="$(command -v php || true)"
if [ -n "$PHP_BIN" ]; then
  "$PHP_BIN" -l "$TMP" >/dev/null || die "lh-mail.php не прошёл проверку синтаксиса php -l (возможно, старая версия PHP)"
  say "Проверка синтаксиса PHP: ok ($("$PHP_BIN" -r 'echo PHP_VERSION;'))"
else
  say "Предупреждение: команда php не найдена, проверка синтаксиса пропущена"
fi
cp "$TMP" "$WEBROOT/lh-mail.php"
chmod 0644 "$WEBROOT/lh-mail.php"
say "Скрипт установлен: $WEBROOT/lh-mail.php"

# ── 3. каталог данных (вне сайта) ──────────────────────────────────────────────
umask 077
mkdir -p "$DATA_DIR"
chmod 0700 "$DATA_DIR"

# ── 4. конфигурация ────────────────────────────────────────────────────────────
phpq() { local s="${1//\\/\\\\}"; s="${s//\'/\\\'}"; printf "'%s'" "$s"; }

ask_secret() {   # $1 = подсказка, $2 = имя переменной окружения-обхода; результат в REPLY
  local v="${!2:-}"
  if [ -n "$v" ]; then REPLY="$v"; return 0; fi
  [ -r /dev/tty ] || die "нет терминала для ввода. Скачайте скрипт и запустите: curl -fsSL $RAW_BASE/setup.sh -o setup.sh && bash setup.sh"
  read -rsp "$1" REPLY </dev/tty || die "ввод прерван"; echo
}

write_config=1
if [ -f "$CONFIG" ]; then
  say "Конфигурация уже есть: $CONFIG"
  keep="y"
  if [ -z "${LH_MAIL_PASSWORD:-}" ] && [ -r /dev/tty ]; then
    read -rp "Оставить как есть? [Y/n]: " keep </dev/tty || keep="y"
  fi
  case "${keep:-y}" in n|N) write_config=1 ;; *) write_config=0 ;; esac
fi

if [ "$write_config" -eq 1 ]; then
  say
  say "Введите данные (ввод скрыт, на экран не выводится)."
  ask_secret "Пароль почтового ящика noreply@vaylonet.ru: " LH_MAIL_PASSWORD; PASS="$REPLY"
  [ -n "$PASS" ] || die "пароль пустой"
  case "$PASS" in *$'\n'*|*$'\r'*) die "пароль содержит перевод строки" ;; esac
  ask_secret "Секрет ретранслятора (вставьте из терминала VPS, не короче 32 символов): " LH_RELAY_SECRET; SECRET="$REPLY"
  [ "${#SECRET}" -ge 32 ] || die "секрет короче 32 символов — скопируйте его целиком"
  case "$SECRET" in *[[:space:]]*) die "в секрете не должно быть пробелов" ;; esac
  CTMP="$(mktemp "$(dirname "$CONFIG")/.lh-mail-config.XXXXXX")"
  {
    echo '<?php'
    echo '// Создано setup.sh. Права 0600. Не публиковать.'
    echo 'return ['
    printf "    'secret'        => %s,\n" "$(phpq "$SECRET")"
    echo "    'transport'     => 'smtp',"
    echo "    'smtp_host'     => 'mail.hosting.reg.ru',"
    echo "    'smtp_port'     => 465,"
    echo "    'smtp_security' => 'ssl',"
    echo "    'smtp_user'     => 'noreply@vaylonet.ru',"
    printf "    'smtp_password' => %s,\n" "$(phpq "$PASS")"
    echo "    'from'          => 'LeadHunter <noreply@vaylonet.ru>',"
    printf "    'data_dir'      => %s,\n" "$(phpq "$DATA_DIR")"
    echo '];'
  } > "$CTMP"
  chmod 0600 "$CTMP"
  [ -z "$PHP_BIN" ] || "$PHP_BIN" -l "$CTMP" >/dev/null || { rm -f "$CTMP"; die "сформированный конфиг некорректен"; }
  mv -f "$CTMP" "$CONFIG"
  say "Конфигурация записана: $CONFIG (права 0600)"
else
  # Секрет для самопроверки берём из существующего конфига (не печатаем).
  SECRET=""
fi
chmod 0600 "$CONFIG" 2>/dev/null || true

# Если конфиг оказался внутри каталога сайта — закрыть его от скачивания.
case "$CONFIG" in
  "$WEBROOT"/*)
    HT="$WEBROOT/.htaccess"
    if ! grep -qs 'lh-mail-config' "$HT" 2>/dev/null; then
      {
        echo
        echo '# LeadHunter: закрыть конфигурацию ретранслятора'
        echo '<FilesMatch "^lh-mail-config.*\.php$">'
        echo '<IfModule mod_authz_core.c>'
        echo 'Require all denied'
        echo '</IfModule>'
        echo '<IfModule !mod_authz_core.c>'
        echo 'Order deny,allow'
        echo 'Deny from all'
        echo '</IfModule>'
        echo '</FilesMatch>'
      } >> "$HT"
      say "Добавлена защита конфигурации в $HT"
    fi ;;
esac

# ── 5. самопроверка: подписанный запрос с заведомо неверным кодом; письмо НЕ отправляется ──
say
if [ -n "$PHP_BIN" ]; then
  if [ -z "$SECRET" ]; then
    SECRET="$("$PHP_BIN" -r '$c = include $argv[1]; echo is_array($c) ? ($c["secret"] ?? "") : "";' "$CONFIG" 2>/dev/null || true)"
  fi
  if [ -n "$SECRET" ]; then
    TS="$(date +%s)"
    NONCE="$("$PHP_BIN" -r 'echo bin2hex(random_bytes(12));')"
    BODY='{"to":"selftest@example.com","code":"abc"}'
    SIG="$(LH_S="$SECRET" "$PHP_BIN" -r 'echo hash_hmac("sha256", $argv[1] . "." . $argv[2] . "." . $argv[3], getenv("LH_S"));' "$TS" "$NONCE" "$BODY")"
    CODE="$(curl -sS -m 25 -o /tmp/lh-selftest.$$ -w '%{http_code}' -X POST "$URL" \
      -H 'Content-Type: application/json' -H "X-LH-Timestamp: $TS" -H "X-LH-Nonce: $NONCE" \
      -H "X-LH-Signature: $SIG" --data "$BODY" 2>/dev/null || true)"
    RESP="$(cat /tmp/lh-selftest.$$ 2>/dev/null || true)"; rm -f /tmp/lh-selftest.$$
    case "$CODE" in
      400) case "$RESP" in
             *bad_request*) say "Самопроверка: ОК — ретранслятор отвечает по $URL, подпись принята." ;;
             *https_required*) say "Самопроверка: адрес доступен, но сервер не считает соединение HTTPS. Проверьте SSL-сертификат сайта и адрес (нужен https://)." ;;
             *) say "Самопроверка: неожиданный ответ 400: $RESP" ;;
           esac ;;
      401) say "Самопроверка: ответ 401 — подпись не принята. Скорее всего, секрет введён неверно: запустите setup.sh снова и вставьте секрет заново." ;;
      500) say "Самопроверка: ответ 500 — ошибка конфигурации. Смотрите $DATA_DIR/lh-mail.log" ;;
      000|"") say "Самопроверка: адрес $URL недоступен. Откройте https://vaylonet.ru в браузере; при необходимости выпустите бесплатный SSL в панели («SSL-сертификаты»)." ;;
      *) say "Самопроверка: ответ $CODE: $RESP" ;;
    esac
  fi
else
  say "Самопроверка пропущена (нет команды php)."
fi

say
say "Готово. Адрес ретранслятора: $URL"
say "Дальше на VPS:  lh-config smtp-test ВАШ@EMAIL"
