#!/usr/bin/env bash
# AutoFlow — вынос на ОТДЕЛЬНЫЙ сервер. Запускать на НОВОМ сервере под root (после покупки и базовой настройки).
# Скрипт ничего не трогает на старом сервере: переключение DNS и выключение AutoFlow на старом — шаги 4–5 из docs/AUTOFLOW_DEPLOY.md.
#
#   migrate-to-server.sh --repo owner/name --domain autoflow.vaylonet.ru --api-upstream https://ai.vaylonet.ru [опции]
#
# Опции:
#   --ref REF              ветка/тег/коммит (по умолчанию main)
#   --dir DIR              каталог установки (по умолчанию /opt/autoflow)
#   --contact-email ADDR   контактный e-mail на лендинге (NEXT_PUBLIC_CONTACT_EMAIL)
#   --contact-telegram @X  контакт в Telegram на лендинге
#   --operator "Название"  оператор персональных данных для /privacy
#   --dry-run              только показать, что будет сделано
# Идемпотентен: повторный запуск пересобирает образ из --ref и перезапускает контейнеры.
set -euo pipefail

REPO=""; DOMAIN=""; UPSTREAM=""; REF="main"; DIR="/opt/autoflow"; CEMAIL=""; CTG=""; OPERATOR=""; DRY=0
die() { printf 'ОШИБКА: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
run() { if [ "$DRY" -eq 1 ]; then printf '  [dry-run] %s\n' "$*"; else "$@"; fi; }

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:-}"; shift 2 ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --api-upstream) UPSTREAM="${2:-}"; shift 2 ;;
    --ref) REF="${2:-}"; shift 2 ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    --contact-email) CEMAIL="${2:-}"; shift 2 ;;
    --contact-telegram) CTG="${2:-}"; shift 2 ;;
    --operator) OPERATOR="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Неизвестный аргумент: $1 (см. --help)" ;;
  esac
done

[[ "$REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || die "Укажите --repo owner/name"
[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || die "Укажите --domain (например autoflow.vaylonet.ru, строчными буквами)"
[[ "$UPSTREAM" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] || die "Укажите --api-upstream вида https://host (куда проксировать /api/*, без пути)"
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] || die "Некорректный --ref"
[[ "$DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "Некорректный --dir"
for v in "$CEMAIL" "$CTG" "$OPERATOR"; do
  if [[ "$v" =~ [[:cntrl:]\$\"\'\\] ]]; then die "Недопустимые символы в контактах/названии оператора"; fi
done
[ "$DRY" -eq 1 ] || [ "$(id -u)" -eq 0 ] || die "Запустите от root"

say "План: AutoFlow на этом сервере"
say "  репозиторий $REPO@$REF, домен $DOMAIN, API-upstream $UPSTREAM, каталог $DIR"
if ! command -v docker >/dev/null 2>&1 && [ "$DRY" -eq 0 ]; then die "Не найден docker. Установите Docker Engine + compose plugin (docs.docker.com/engine/install), затем повторите"; fi
if ! command -v git >/dev/null 2>&1 && [ "$DRY" -eq 0 ]; then die "Не найден git (apt-get install -y git)"; fi

# 1. DNS: домен должен указывать на этот сервер, иначе Caddy не получит сертификат (можно продолжать и до переключения)
if command -v getent >/dev/null 2>&1; then
  resolved="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
  say "  DNS: $DOMAIN → ${resolved:-<нет записи>}"
fi

# 2. Исходники и образ
SRC="$DIR/src"
run install -d -m 0755 "$DIR"
if [ "$DRY" -eq 1 ]; then
  say "  [dry-run] git clone/fetch https://github.com/$REPO.git → $SRC (ref $REF)"
  SHA=dryrun00000
else
  [ -d "$SRC/.git" ] || git clone --no-checkout --filter=blob:none "https://github.com/$REPO.git" "$SRC"
  git -C "$SRC" fetch --depth=1 origin "$REF"
  git -C "$SRC" checkout --force --detach FETCH_HEAD
  SHA="$(git -C "$SRC" rev-parse --short=12 HEAD)"
fi
IMAGE="lh-autoflow:$SHA"
BUILD_ARGS=(--build-arg "NEXT_PUBLIC_SITE_URL=https://$DOMAIN")
[ -z "$CEMAIL" ] || BUILD_ARGS+=(--build-arg "NEXT_PUBLIC_CONTACT_EMAIL=$CEMAIL")
[ -z "$CTG" ] || BUILD_ARGS+=(--build-arg "NEXT_PUBLIC_CONTACT_TELEGRAM=$CTG")
[ -z "$OPERATOR" ] || BUILD_ARGS+=(--build-arg "NEXT_PUBLIC_OPERATOR_NAME=$OPERATOR")
say "Сборка образа $IMAGE"
run docker build -t "$IMAGE" "${BUILD_ARGS[@]}" -f "$SRC/apps/autoflow-web/Dockerfile" "$SRC"

# 3. Конфигурация и запуск
say "Конфигурация в $DIR"
if [ "$DRY" -eq 1 ]; then
  say "  [dry-run] копирование standalone/docker-compose.yml и Caddyfile, запись .env (AUTOFLOW_DOMAIN, AUTOFLOW_API_UPSTREAM, AUTOFLOW_IMAGE)"
else
  install -m 0644 "$SRC/infra/autoflow/standalone/docker-compose.yml" "$DIR/docker-compose.yml"
  install -m 0644 "$SRC/infra/autoflow/standalone/Caddyfile" "$DIR/Caddyfile"
  tmp="$(umask 077; mktemp "$DIR/.env.XXXXXX")"
  printf 'AUTOFLOW_DOMAIN=%s\nAUTOFLOW_API_UPSTREAM=%s\nAUTOFLOW_IMAGE=%s\n' "$DOMAIN" "$UPSTREAM" "$IMAGE" > "$tmp"
  mv -f "$tmp" "$DIR/.env"
fi
run docker compose --env-file "$DIR/.env" -f "$DIR/docker-compose.yml" up -d --remove-orphans

# 4. Проверка здоровья
if [ "$DRY" -eq 0 ]; then
  ok=0
  for _ in $(seq 1 40); do
    cid="$(docker compose --env-file "$DIR/.env" -f "$DIR/docker-compose.yml" ps -q autoflow-web 2>/dev/null || true)"
    if [ -n "$cid" ] && [ "$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || true)" = healthy ]; then ok=1; break; fi
    sleep 3
  done
  [ "$ok" -eq 1 ] || die "autoflow-web не стал здоровым: docker compose --env-file $DIR/.env -f $DIR/docker-compose.yml logs autoflow-web"
  say "autoflow-web: здоров"
fi

cat <<EOF

Готово. Дальше (вручную, см. docs/AUTOFLOW_DEPLOY.md, шаги 4–5):
  1) Проверка до смены DNS:  curl -sS --resolve $DOMAIN:443:<IP_нового_сервера> https://$DOMAIN/ -o /dev/null -w '%{http_code}\n'
     (сертификат Caddy выдаст, когда домен начнёт указывать на этот сервер)
  2) Переключите DNS: A-запись $DOMAIN → IP этого сервера (TTL заранее уменьшите до 300 с).
  3) Когда сайт открывается с нового сервера, на СТАРОМ сервере выполните:  lh-config autoflow off
  4) Обновления на отдельном сервере: повторный запуск этого скрипта с новым --ref (автообновление для него пока не настроено).
EOF
