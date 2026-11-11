#!/usr/bin/env bash
# LeadHunter — установка на чистый VPS ОДНОЙ командой (без токенов и секретов). Запускать от root.
#
#   curl -fsSL https://raw.githubusercontent.com/OWNER/REPO/main/infra/deploy/install.sh | bash -s -- --repo OWNER/REPO --domain ai.vaylonet.ru
#
# Что делает (ничего не удаляет; при занятых портах 80/443 останавливается и ничего не ломает):
#   1. проверяет, что домен указывает на этот сервер и порты 80/443 свободны;
#   2. ставит Docker, firewall (22/80/443), fail2ban, автообновления безопасности, swap (если нет);
#   3. создаёт /opt/leadhunter и ставит службу `lh-update` (systemd-таймер каждые ~3 мин):
#      она следит за веткой main на GitHub; как только там появляется новый коммит с зелёными тестами —
#      собирает и запускает сайт, при сбое сама откатывается. В main код попадает только с разрешения владельца (в чате);
#   4. генерирует в /opt/leadhunter/.env секреты БД и API (не затирая существующие) и ставит `lh-config`
#      (настройка почты/владельца на сервере без передачи секретов в чат).
# Секретов, токенов и входящего SSH для деплоя не нужно. Вход на сайт — по коду из письма (ADR-015);
# basic-auth по умолчанию выключен (включается `lh-config gate on`).
set -euo pipefail

REPO=""; REF="main"; DOMAIN="ai.vaylonet.ru"; HARDEN=0; SKIP_FIRST=0; NEW_PASS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:-}"; shift 2 ;;
    --ref) REF="${2:-}"; shift 2 ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --harden-ssh) HARDEN=1; shift ;;
    --no-first-run) SKIP_FIRST=1; shift ;;
    --new-password) NEW_PASS=1; shift ;;   # no-op: basic-auth больше не основной механизм (см. `lh-config gate on`)
    *) echo "Неизвестный аргумент: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nОШИБКА: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Запустите от root"
[[ "$REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || die "Укажите --repo OWNER/REPO"
[[ "$DOMAIN" =~ ^[a-z0-9.-]+$ ]] || die "Некорректный домен"
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] || die "Некорректный --ref"
# shellcheck disable=SC1091
. /etc/os-release
case "${ID}" in ubuntu|debian) ;; *) die "Поддерживаются Ubuntu/Debian, найдено: ${ID}" ;; esac
export DEBIAN_FRONTEND=noninteractive

say "Проверка: домен → этот сервер"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg jq git ufw fail2ban unattended-upgrades openssl iproute2 >/dev/null
DNS_IPS="$(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u | tr '\n' ' ')"
LOCAL_IPS="${LH_LOCAL_IPS:-$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | tr '\n' ' ')}"
MATCH=""
for ip in $DNS_IPS; do for l in $LOCAL_IPS; do [ "$ip" = "$l" ] && MATCH="$ip"; done; done
[ -n "$MATCH" ] || die "DNS $DOMAIN → [${DNS_IPS}], а адреса этого сервера [${LOCAL_IPS}]. Сертификат HTTPS не выпустится — поправьте DNS."
echo "OK: $DOMAIN → $MATCH"

say "Проверка: порты 80 и 443 свободны (если там уже что-то работает — не трогаем)"
if [ -z "${LH_SKIP_PORT_CHECK:-}" ] && [ ! -f /opt/leadhunter/lh.conf ]; then
  BUSY="$(ss -ltnH '( sport = :80 or sport = :443 )' 2>/dev/null || true)"
  if [ -n "$BUSY" ]; then
    echo "$BUSY" >&2
    die "Порты 80/443 уже заняты другим сервисом. Я ничего не менял. Освободите порты или пришлите вывод 'ss -ltnp' для выбора схемы."
  fi
fi

if ! command -v docker >/dev/null 2>&1; then
  say "Docker (официальный репозиторий)"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  systemctl enable --now docker
fi

if [ -z "$(swapon --show --noheadings 2>/dev/null)" ]; then
  MEM_MB="$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)"
  SWAP_GB=2; [ "$MEM_MB" -lt 3000 ] && SWAP_GB=3
  say "Swap ${SWAP_GB} ГБ (сборка сайта выполняется на сервере; RAM: ${MEM_MB} МБ)"
  fallocate -l "${SWAP_GB}G" /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "Каталог /opt/leadhunter и конфигурация"
install -d -m 0755 /opt/leadhunter
printf 'REPO=%s\nBRANCH=main\n' "$REPO" > /opt/leadhunter/lh.conf
ENVF=/opt/leadhunter/.env
[ -f "$ENVF" ] || install -m 0600 /dev/null "$ENVF"
[ "$NEW_PASS" -eq 1 ] && echo "Флаг --new-password больше ничего не делает: сайт защищён входом по e-mail коду; шлюз basic-auth — 'lh-config gate on'."

say "Служба обновления lh-update"
if [ -n "${LH_UPDATE_FILE:-}" ]; then cp "$LH_UPDATE_FILE" /usr/local/sbin/lh-update
else curl -fsSL "https://raw.githubusercontent.com/$REPO/$REF/infra/deploy/lh-update.sh" -o /usr/local/sbin/lh-update; fi
bash -n /usr/local/sbin/lh-update || die "Скачанный lh-update повреждён"
chmod 0755 /usr/local/sbin/lh-update
if [ -n "${LH_CONFIG_FILE:-}" ]; then cp "$LH_CONFIG_FILE" /usr/local/sbin/lh-config
else curl -fsSL "https://raw.githubusercontent.com/$REPO/$REF/infra/deploy/lh-config.sh" -o /usr/local/sbin/lh-config; fi
bash -n /usr/local/sbin/lh-config || die "Скачанный lh-config повреждён"
chmod 0755 /usr/local/sbin/lh-config
# секреты БД/API генерируются один раз; существующие значения не затираются
/usr/local/sbin/lh-config init --domain "$DOMAIN"
cat > /etc/systemd/system/lh-update.service <<'UNIT'
[Unit]
Description=LeadHunter: обновление из GitHub Releases
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/lh-update
Nice=10
TimeoutStartSec=1800
UNIT
cat > /etc/systemd/system/lh-update.timer <<'UNIT'
[Unit]
Description=LeadHunter: проверка новых релизов каждые 3 минуты

[Timer]
OnBootSec=2min
OnUnitActiveSec=3min
RandomizedDelaySec=30
AccuracySec=30s

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now lh-update.timer >/dev/null

say "Firewall, fail2ban, автообновления безопасности"
SSHPORT="$( (sshd -T 2>/dev/null || true) | awk '/^port /{print $2; exit}')"; SSHPORT="${SSHPORT:-22}"
# Чтобы не потерять доступ (SSH, консоль провайдера), все уже слушающие внешние TCP-порты остаются открытыми.
KEEP="$(ss -ltnH 2>/dev/null | awk '{a=$4; n=split(a,x,":"); p=x[n]; if (a !~ /^127\./ && a !~ /^\[::1\]/) print p}' | sort -un | grep -vE '^(80|443)$' || true)"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
for p in $KEEP; do
  if [ "$p" = "$SSHPORT" ]; then ufw limit "${p}/tcp" >/dev/null; else ufw allow "${p}/tcp" >/dev/null; fi
done
echo "Оставлены открытыми существующие порты: ${KEEP:-нет} (плюс 80 и 443 для сайта)"
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null
if command -v sshd >/dev/null 2>&1; then
  printf '[sshd]\nenabled = true\nmaxretry = 5\nfindtime = 10m\nbantime = 1h\n' > /etc/fail2ban/jail.d/leadhunter.local
  systemctl enable --now fail2ban >/dev/null 2>&1 || true
  systemctl restart fail2ban || true
fi
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

if [ "$HARDEN" -eq 1 ]; then
  say "Отключение входа по паролю"
  command -v sshd >/dev/null 2>&1 || die "На этом сервере нет SSH-сервера (вход через консоль провайдера) — отключать пароль нечего."
  [ -s /root/.ssh/authorized_keys ] || die "У root нет SSH-ключа — вы потеряете доступ. Сначала добавьте свой ключ."
  install -d -m 0755 /etc/ssh/sshd_config.d
  printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/99-leadhunter.conf
  sshd -t
  systemctl reload ssh 2>/dev/null || systemctl reload sshd
fi

if [ "$SKIP_FIRST" -eq 0 ]; then
  say "Первая проверка релизов"
  /usr/local/sbin/lh-update || echo "(релизов ещё нет или сборка не удалась — см. 'journalctl -u lh-update')"
fi

say "Готово"
cat <<EOF
Сервер настроен. Служба lh-update проверяет ветку main на GitHub каждые ~3 минуты:
новый коммит с зелёными тестами автоматически собирается и выкатывается на https://$DOMAIN.
Пауза автообновления: touch /opt/leadhunter/.paused (возобновить: rm /opt/leadhunter/.paused)
Откат: lh-update --rollback (откатанная версия больше не выкатывается)
Логи: journalctl -u lh-update -n 50
Почта для кодов входа: выполните на сервере 'lh-config smtp', затем 'lh-config owner ВАШ@ПОЧТА' (см. docs/OPERATIONS.md).
Пока почта не настроена, регистрация отвечает 503 MAIL_UNAVAILABLE (так задумано).
Сейчас: смените пароль root и по возможности перейдите на вход по SSH-ключу (флаг --harden-ssh).
EOF
