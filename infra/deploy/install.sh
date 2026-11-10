#!/usr/bin/env bash
# LeadHunter — автоустановщик с GitHub на сервер. Запускается ОДНОЙ командой на чистом VPS от root.
#
#   read -rs -p "GitHub token: " T; echo
#   curl -fsSL -H "Authorization: Bearer $T" -H "Accept: application/vnd.github.raw" \
#     "https://api.github.com/repos/OWNER/REPO/contents/infra/deploy/install.sh?ref=main" \
#     | GH_TOKEN="$T" bash -s -- --repo OWNER/REPO --domain ai.vaylonet.ru
#
# Что делает:
#   1. проверяет токен, DNS домена и что домен указывает на ЭТОТ сервер;
#   2. скачивает bootstrap-vps.sh из репозитория и настраивает сервер (Docker, deploy-пользователь, firewall…);
#   3. создаёт ключ деплоя; в GitHub создаёт окружение `production` с обязательным одобрением (вами)
#      и записывает секреты DEPLOY_HOST / DEPLOY_SSH_KEY / DEPLOY_KNOWN_HOSTS;
#   4. стирает ключи и токен с сервера. Если одобрение настроить нельзя — секреты НЕ записываются (безопасный отказ).
# Токен: fine-grained PAT только на этот репозиторий (Administration RW, Secrets RW, Contents R, Actions RW, Metadata R)
# со сроком 1 день, либо classic `repo`. После установки отзовите токен. Токен не сохраняется на диск.
set -euo pipefail

REPO=""; REF="main"; DOMAIN="ai.vaylonet.ru"; REVIEWER=""; HARDEN=0; DEPLOY_NOW=0
BOOTSTRAP_FILE=""        # для тестов: путь к локальному bootstrap
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:-}"; shift 2 ;;
    --ref) REF="${2:-}"; shift 2 ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --reviewer) REVIEWER="${2:-}"; shift 2 ;;
    --harden-ssh) HARDEN=1; shift ;;
    --deploy-now) DEPLOY_NOW=1; shift ;;
    --bootstrap-file) BOOTSTRAP_FILE="${2:-}"; shift 2 ;;
    *) echo "Неизвестный аргумент: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nОШИБКА: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Запустите от root"
[[ "$REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || die "Укажите --repo OWNER/REPO"
[[ "$DOMAIN" =~ ^[a-z0-9.-]+$ ]] || die "Некорректный домен"
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] || die "Некорректный --ref"
OWNER="${REPO%%/*}"; REVIEWER="${REVIEWER:-$OWNER}"
[[ "$REVIEWER" =~ ^[A-Za-z0-9-]+$ ]] || die "Некорректный --reviewer"

if [ -z "${GH_TOKEN:-}" ]; then
  read -rs -p "GitHub token (ввод скрыт): " GH_TOKEN; echo
fi
[ -n "$GH_TOKEN" ] || die "Нужен токен GitHub"
export GH_TOKEN
export GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1

WORK="$(mktemp -d)"; chmod 700 "$WORK"
cleanup() {
  if [ -d "$WORK" ]; then find "$WORK" -type f -exec shred -u {} + 2>/dev/null || true; rm -rf "$WORK"; fi
  unset GH_TOKEN
}
trap cleanup EXIT

say "Необходимые пакеты"
export DEBIAN_FRONTEND=noninteractive
if ! command -v gh >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg jq openssh-client iproute2 >/dev/null
fi
if ! command -v gh >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg
  chmod a+r /etc/apt/keyrings/githubcli.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
  apt-get update -qq
  apt-get install -y -qq gh >/dev/null
fi

say "Проверка доступа к репозиторию $REPO"
gh api "repos/$REPO" --jq '.full_name' >/dev/null || die "Токен не видит репозиторий $REPO (проверьте права токена)"
REVIEWER_ID="$(gh api "users/$REVIEWER" --jq '.id')" || die "Пользователь GitHub $REVIEWER не найден"

say "Проверка DNS: $DOMAIN должен указывать на этот сервер"
DNS_IPS="$(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u | tr '\n' ' ')"
LOCAL_IPS="${LH_LOCAL_IPS:-$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | tr '\n' ' ')}"
MATCH=""
for ip in $DNS_IPS; do for l in $LOCAL_IPS; do [ "$ip" = "$l" ] && MATCH="$ip"; done; done
[ -n "$MATCH" ] || die "DNS $DOMAIN → [${DNS_IPS}], а адреса этого сервера [${LOCAL_IPS}]. Сертификат HTTPS не выпустится — поправьте DNS."
HOST_IP="$MATCH"
echo "OK: $DOMAIN → $HOST_IP"

say "Загрузка bootstrap-vps.sh ($REPO@$REF)"
if [ -n "$BOOTSTRAP_FILE" ]; then
  cp "$BOOTSTRAP_FILE" "$WORK/bootstrap-vps.sh"
else
  gh api -H "Accept: application/vnd.github.raw" "repos/$REPO/contents/infra/deploy/bootstrap-vps.sh?ref=$REF" > "$WORK/bootstrap-vps.sh" \
    || die "Не удалось скачать infra/deploy/bootstrap-vps.sh из ветки $REF (она должна существовать в репозитории)"
fi
bash -n "$WORK/bootstrap-vps.sh" || die "Скачанный скрипт повреждён"

say "Ключ деплоя"
ssh-keygen -q -t ed25519 -N '' -C "github-deploy-$(date +%Y%m%d)" -f "$WORK/deploy_key"

say "Настройка сервера (bootstrap)"
ARGS=(--deploy-pubkey "$(cat "$WORK/deploy_key.pub")" --domain "$DOMAIN")
[ "$HARDEN" -eq 1 ] && ARGS+=(--harden-ssh)
bash "$WORK/bootstrap-vps.sh" "${ARGS[@]}"

say "GitHub: окружение production с обязательным одобрением ($REVIEWER)"
BODY="$(jq -n --argjson id "$REVIEWER_ID" '{reviewers:[{type:"User",id:$id}],deployment_branch_policy:{protected_branches:false,custom_branch_policies:true}}')"
printf '%s' "$BODY" | gh api -X PUT "repos/$REPO/environments/production" --input - >/dev/null \
  || die "Не удалось создать окружение production (нужны права Administration у токена)"
gh api -X POST "repos/$REPO/environments/production/deployment-branch-policies" -f name=main -f type=branch >/dev/null 2>&1 || true

# Безопасный отказ: без включённого одобрения секреты деплоя не записываем (иначе деплой пойдёт без вашей кнопки).
GOT="$(gh api "repos/$REPO/environments/production" --jq '[.protection_rules[]? | select(.type=="required_reviewers")] | length' 2>/dev/null || echo 0)"
if [ "${GOT:-0}" -lt 1 ]; then
  die "GitHub не включил «Required reviewers» для приватного репозитория (нужен платный план GitHub или публичный репозиторий). Секреты деплоя НЕ записаны, чтобы не получить автодеплой без вашего одобрения. Сервер уже настроен; выберите вариант и перезапустите установщик."
fi

say "GitHub: секреты окружения production"
HOSTKEY="${LH_HOSTKEY_PUB:-/etc/ssh/ssh_host_ed25519_key.pub}"
KNOWN="$HOST_IP $(cut -d' ' -f1,2 "$HOSTKEY")"
gh secret set DEPLOY_HOST --env production --repo "$REPO" --body "$HOST_IP" >/dev/null
gh secret set DEPLOY_SSH_KEY --env production --repo "$REPO" < "$WORK/deploy_key" >/dev/null
gh secret set DEPLOY_KNOWN_HOSTS --env production --repo "$REPO" --body "$KNOWN" >/dev/null
echo "Записаны: DEPLOY_HOST, DEPLOY_SSH_KEY, DEPLOY_KNOWN_HOSTS (окружение production)"

if [ "$DEPLOY_NOW" -eq 1 ]; then
  say "Запуск первого деплоя"
  gh workflow run ci.yml --repo "$REPO" --ref main >/dev/null && echo "Запущено. Одобрите деплой: https://github.com/$REPO/actions" \
    || echo "Не удалось запустить workflow (нужна ветка main с .github/workflows/ci.yml и права Actions у токена)."
fi

say "Готово"
cat <<EOF
Сервер: $HOST_IP ($DOMAIN) настроен. Ключ деплоя записан в GitHub и стёрт с сервера.
Дальше:
  1) Слейте ветку с проектом в main (или нажмите Run workflow в Actions).
  2) GitHub пришлёт запрос на одобрение деплоя → «Review deployments» → Approve.
  3) Откройте https://$DOMAIN (логин owner, пароль — из вывода выше).
  4) ОТОЗОВИТЕ токен GitHub, который вы вводили, и смените пароль root.
EOF
