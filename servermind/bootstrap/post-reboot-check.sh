#!/usr/bin/env bash
# Проверка ПОСЛЕ перезагрузки VPS: всё ли поднялось само (Docker, контейнеры ServerMind, таймер автообновления, ответ сайта).
# Только чтение, ничего не меняет.   sudo bash /opt/servermind/bin/post-reboot-check.sh
# Код выхода 0 — всё в порядке; 1 — хотя бы одна проверка не прошла (подробности в выводе).
set -u

SM_ROOT="${SM_ROOT:-/opt/servermind}"
DOCKER="${DOCKER:-docker}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
CURL="${CURL:-curl}"
EXPECTED_SERVICES="${EXPECTED_SERVICES:-4}"   # postgres, api, web, caddy
ATTEMPTS="${ATTEMPTS:-20}"                    # контейнерам нужно время на запуск после загрузки
SLEEP="${SLEEP:-6}"

fails=0
ok()   { printf '  ✔ %s\n' "$*"; }
bad()  { printf '  ✘ %s\n' "$*"; fails=$((fails + 1)); }
dc()   { "$DOCKER" compose -p servermind --project-directory "$SM_ROOT/compose" "$@"; }
check() { if [[ "$1" == "$2" ]]; then ok "$3"; else bad "$4"; fi; }   # check ФАКТ ОЖИДАЕМОЕ «ок» «плохо»

echo "Проверка после перезагрузки ($(date -u +%FT%TZ)), аптайм: $(uptime -p 2>/dev/null || echo '?')"

check "$("$SYSTEMCTL" is-active docker 2>/dev/null)" active "служба docker активна" "служба docker НЕ активна (systemctl enable --now docker)"
check "$("$SYSTEMCTL" is-enabled docker 2>/dev/null)" enabled "docker запускается при загрузке" "docker не включён в автозапуск (systemctl enable docker)"

timer="servermind-update.timer"
check "$("$SYSTEMCTL" is-active "$timer" 2>/dev/null)" active "таймер автообновления активен" "таймер $timer НЕ активен (systemctl enable --now $timer)"
check "$("$SYSTEMCTL" is-enabled "$timer" 2>/dev/null)" enabled "таймер включён в автозапуск" "таймер $timer не включён в автозапуск"

# Контейнеры: ждём, пока все ожидаемые перейдут в running и (где есть проверка) healthy
state_ok=0; detail=""
for ((i = 1; i <= ATTEMPTS; i++)); do
  ids="$(dc ps -q 2>/dev/null)"
  total=0; good=0; detail=""
  for id in $ids; do
    total=$((total + 1))
    s="$("$DOCKER" inspect -f '{{.Name}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id" 2>/dev/null)"
    read -r name st health <<< "$s"
    if [[ "$st" == running && ( -z "$health" || "$health" == healthy ) ]]; then good=$((good + 1)); else detail+=" ${name#/}=$st${health:+/$health}"; fi
  done
  if (( total >= EXPECTED_SERVICES && good == total )); then state_ok=1; break; fi
  (( i < ATTEMPTS )) && sleep "$SLEEP"
done
if (( state_ok )); then ok "контейнеры ServerMind: $good из $total running/healthy"; else bad "контейнеры не в порядке (${good:-0} из ${total:-0}; ожидается ≥ $EXPECTED_SERVICES):${detail:- нет контейнеров}"; fi

# Ответ сайта локально: любой код < 500 (при домене Caddy отвечает редиректом на HTTPS)
port="$(sed -n 's/^SERVERMIND_HTTP_PORT=//p' "$SM_ROOT/compose/.env" 2>/dev/null | tail -n 1)"; port="${port:-80}"
code="$("$CURL" -s -o /dev/null -m 10 -w '%{http_code}' "http://127.0.0.1:$port/" 2>/dev/null)"
if [[ "$code" =~ ^[0-9]{3}$ ]] && (( code >= 200 && code < 500 )); then ok "сайт отвечает на 127.0.0.1:$port (HTTP $code)"; else bad "сайт не отвечает на 127.0.0.1:$port (код: ${code:-нет})"; fi

if [[ -s "$SM_ROOT/state/deployed.env" ]]; then ok "состояние релиза на месте ($(sed -n 's/^COMMIT=//p' "$SM_ROOT/state/deployed.env" | head -n 1 | cut -c1-12))"; else bad "нет $SM_ROOT/state/deployed.env"; fi

echo
if (( fails == 0 )); then echo "ИТОГ: всё поднялось само, вмешательство не требуется."; exit 0; fi
echo "ИТОГ: проблем — $fails. Логи: docker compose -p servermind --project-directory $SM_ROOT/compose logs --tail 100"
exit 1
