#!/usr/bin/env bash
# LeadHunter — первичная настройка чистого VPS (Ubuntu 22.04+/Debian 12+). Идемпотентен.
# Запускать от root в консоли провайдера или по SSH. Скрипт ничего не удаляет.
#
#   sudo bash bootstrap-vps.sh --deploy-pubkey "ssh-ed25519 AAAA... github-deploy" [--domain ai.vaylonet.ru] [--harden-ssh]
#
# Что делает: ставит Docker, создаёт пользователя `deploy` с ключом, ограниченным ОДНОЙ командой
# (развернуть образ / откат / статус), включает firewall (22, 80, 443), fail2ban, автообновления безопасности,
# создаёт /opt/leadhunter. Опционально (--harden-ssh) отключает вход по паролю — только если у root уже есть ключ.
set -euo pipefail

DOMAIN="ai.vaylonet.ru"
PUBKEY=""
HARDEN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --deploy-pubkey) PUBKEY="${2:-}"; shift 2 ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --harden-ssh) HARDEN=1; shift ;;
    *) echo "Неизвестный аргумент: $1" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "Запустите от root" >&2; exit 1; }
[[ "$PUBKEY" =~ ^ssh-(ed25519|rsa)\ [A-Za-z0-9+/=]+(\ .*)?$ ]] || { echo "Нужен --deploy-pubkey \"ssh-ed25519 AAAA...\" (публичный ключ)" >&2; exit 2; }
[[ "$DOMAIN" =~ ^[a-z0-9.-]+$ ]] || { echo "Некорректный домен" >&2; exit 2; }
# shellcheck disable=SC1091
. /etc/os-release
case "${ID}" in ubuntu|debian) ;; *) echo "Поддерживаются Ubuntu/Debian, найдено: ${ID}" >&2; exit 1 ;; esac

log() { printf '\n==> %s\n' "$*"; }
export DEBIAN_FRONTEND=noninteractive

log "Пакеты"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg ufw fail2ban unattended-upgrades openssl

if ! command -v docker >/dev/null 2>&1; then
  log "Docker (официальный репозиторий)"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now docker
else
  log "Docker уже установлен — пропускаю"
fi

log "Пользователь deploy"
id deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash deploy
usermod -aG docker deploy
install -d -m 0755 -o deploy -g deploy /opt/leadhunter /opt/leadhunter/incoming

log "Скрипты развёртывания (принадлежат root, deploy не может их менять)"
cat > /usr/local/sbin/lh-deploy-entry <<'ENTRY_EOF'
#!/usr/bin/env bash
# Единственная команда, доступная ключу GitHub Actions (forced command). Принимает: deploy <ref> <actor> | rollback | status
set -euo pipefail
read -r action arg1 arg2 _ <<<"${SSH_ORIGINAL_COMMAND:-}" || true
case "${action:-}" in
  deploy)
    [[ "${arg1:-}" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]] || { echo "Недопустимая ссылка на образ" >&2; exit 2; }
    [[ "${arg2:-}" =~ ^[A-Za-z0-9-]{1,39}$ ]] || { echo "Недопустимый actor" >&2; exit 2; }
    IFS= read -r token                      # 1-я строка stdin — краткоживущий токен GHCR
    [ -n "$token" ] || { echo "Нет токена" >&2; exit 2; }
    rm -rf /opt/leadhunter/incoming && mkdir -p /opt/leadhunter/incoming
    tar xzf - -C /opt/leadhunter/incoming --no-same-owner --no-same-permissions   # остальное stdin — конфиги (compose, Caddyfile)
    LH_GHCR_TOKEN="$token" exec /usr/local/sbin/lh-deploy "$arg1" "$arg2"
    ;;
  rollback) exec /usr/local/sbin/lh-deploy --rollback ;;
  status)   cd /opt/leadhunter && exec docker compose --env-file .env -f docker-compose.prod.yml ps ;;
  *) echo "Команда не разрешена" >&2; exit 2 ;;
esac
ENTRY_EOF

cat > /usr/local/sbin/lh-deploy <<'DEPLOY_EOF'
#!/usr/bin/env bash
# Развёртывание образа по digest с проверкой здоровья и автоматическим откатом.
set -euo pipefail
APP=/opt/leadhunter
cd "$APP"
exec 9>"$APP/.deploy.lock"
flock -n 9 || { echo "Другой деплой уже выполняется" >&2; exit 3; }

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
compose() { docker compose --env-file "$APP/.env" -f "$APP/docker-compose.prod.yml" "$@"; }
get_env() { grep -E "^$1=" "$APP/.env" | head -1 | cut -d= -f2- || true; }
set_env() { if grep -qE "^$1=" "$APP/.env"; then sed -i "s|^$1=.*|$1=$2|" "$APP/.env"; else echo "$1=$2" >> "$APP/.env"; fi; }
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

if [ "${1:-}" = "--rollback" ]; then
  ref="$(cat "$APP/.prev_good" 2>/dev/null || true)"
  [ -n "$ref" ] || { echo "Нет предыдущей рабочей версии" >&2; exit 4; }
  log "Откат на $ref"
else
  ref="$1"; actor="$2"
  printf '%s' "$LH_GHCR_TOKEN" | docker login ghcr.io -u "$actor" --password-stdin >/dev/null
  trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
fi

[ -f incoming/compose/docker-compose.prod.yml ] && install -m 0644 incoming/compose/docker-compose.prod.yml "$APP/docker-compose.prod.yml"
[ -f incoming/caddy/Caddyfile ] && install -m 0644 incoming/caddy/Caddyfile "$APP/Caddyfile"
[ -f "$APP/docker-compose.prod.yml" ] || { echo "Нет docker-compose.prod.yml" >&2; exit 5; }

previous="$(get_env WEB_IMAGE)"
log "Загрузка образа"
docker pull "$ref"
set_env WEB_IMAGE "$ref"
log "Запуск"
compose up -d --remove-orphans

if healthy; then
  current_good="$(cat "$APP/.last_good" 2>/dev/null || true)"
  [ -n "$current_good" ] && [ "$current_good" != "$ref" ] && echo "$current_good" > "$APP/.prev_good"
  echo "$ref" > "$APP/.last_good"
  docker image prune -f >/dev/null 2>&1 || true
  log "Готово: версия работает"
else
  log "Проверка здоровья не пройдена"
  if [ -n "$previous" ] && [ "$previous" != "$ref" ]; then
    set_env WEB_IMAGE "$previous"
    compose up -d --remove-orphans
    log "Выполнен автоматический откат на $previous"
  fi
  exit 1
fi
DEPLOY_EOF
chmod 0755 /usr/local/sbin/lh-deploy-entry /usr/local/sbin/lh-deploy
chown root:root /usr/local/sbin/lh-deploy-entry /usr/local/sbin/lh-deploy

log "SSH-ключ deploy (разрешена только команда lh-deploy-entry)"
install -d -m 0700 -o deploy -g deploy /home/deploy/.ssh
printf 'restrict,command="/usr/local/sbin/lh-deploy-entry" %s\n' "$PUBKEY" > /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 0600 /home/deploy/.ssh/authorized_keys

log "Файл окружения /opt/leadhunter/.env"
ENVF=/opt/leadhunter/.env
if [ ! -f "$ENVF" ]; then
  install -m 0600 -o deploy -g deploy /dev/null "$ENVF"
  printf 'DOMAIN=%s\nBASIC_USER=owner\nBASIC_HASH=\nWEB_IMAGE=\n' "$DOMAIN" > "$ENVF"
fi
if ! grep -qE '^BASIC_HASH=.+' "$ENVF"; then
  PASS="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
  HASH="$(docker run --rm caddy:2.8-alpine caddy hash-password --plaintext "$PASS")"
  sed -i "s|^BASIC_HASH=.*|BASIC_HASH=${HASH//\$/\$\$}|" "$ENVF"
  echo
  echo "################################################################"
  echo " Временный пароль входа на сайт (до появления настоящей авторизации)"
  echo "   логин: owner     пароль: ${PASS}"
  echo " Сохраните его в менеджере паролей. Показан ТОЛЬКО сейчас."
  echo "################################################################"
fi

log "Firewall (ufw)"
SSHPORT="$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}')"; SSHPORT="${SSHPORT:-22}"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw limit "${SSHPORT}/tcp" >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null
ufw status verbose | head -12

log "fail2ban и автообновления безопасности"
printf '[sshd]\nenabled = true\nmaxretry = 5\nfindtime = 10m\nbantime = 1h\n' > /etc/fail2ban/jail.d/leadhunter.local
systemctl enable --now fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban || true
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

if [ "$HARDEN" -eq 1 ]; then
  log "Отключение входа по паролю"
  if [ ! -s /root/.ssh/authorized_keys ]; then
    echo "ОТКАЗ: у root нет SSH-ключа (/root/.ssh/authorized_keys пуст) — вы потеряете доступ. Сначала добавьте свой ключ." >&2
    exit 1
  fi
  install -d -m 0755 /etc/ssh/sshd_config.d
  printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/99-leadhunter.conf
  sshd -t
  systemctl reload ssh 2>/dev/null || systemctl reload sshd
  echo "Вход по паролю отключён. НЕ закрывайте текущую сессию, пока не проверите вход по ключу из нового окна."
fi

log "Готово. Отпечаток SSH-ключа хоста (сверьте при первом подключении / для DEPLOY_KNOWN_HOSTS):"
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub || true
echo
echo "Дальше: добавьте в GitHub (Settings → Environments → production → Secrets) DEPLOY_HOST, DEPLOY_SSH_KEY, DEPLOY_KNOWN_HOSTS."
