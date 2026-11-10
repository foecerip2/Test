#!/usr/bin/env bash
# Тесты post-reboot-check.sh на подставных docker/systemctl/curl. Реальные службы не используются.
# shellcheck disable=SC2016,SC1090,SC2034,SC2155  # условия check — строки для eval
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../post-reboot-check.sh"
PASS=0; FAILN=0
ok()  { PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"; }
bad() { FAILN=$((FAILN + 1)); printf '  FAIL  %s\n' "$1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

setup() {
  T="$(mktemp -d)"
  mkdir -p "$T/root/state" "$T/root/compose"
  echo "COMMIT=abcdef1234567890" > "$T/root/state/deployed.env"
  # docker: «compose ps -q» печатает id контейнеров; «inspect -f … ID» печатает состояние из FAKE_CONTAINERS (id=имя:статус:здоровье)
  cat > "$T/docker" <<'EOS'
#!/usr/bin/env bash
if [[ "$1" == compose ]]; then
  for kv in $FAKE_CONTAINERS; do echo "${kv%%=*}"; done
elif [[ "$1" == inspect ]]; then
  id="${@: -1}"
  for kv in $FAKE_CONTAINERS; do
    if [[ "${kv%%=*}" == "$id" ]]; then IFS=: read -r n s h <<< "${kv#*=}"; echo "/$n $s $h"; fi
  done
fi
EOS
  cat > "$T/systemctl" <<'EOS'
#!/usr/bin/env bash
# systemctl is-active|is-enabled UNIT → значение из FAKE_UNITS (например "docker:is-active=active")
for kv in $FAKE_UNITS; do
  if [[ "${kv%%=*}" == "$2:$1" ]]; then echo "${kv#*=}"; exit 0; fi
done
echo unknown; exit 3
EOS
  printf '#!/usr/bin/env bash\necho -n "${FAKE_HTTP:-200}"\n' > "$T/curl"
  chmod +x "$T/docker" "$T/systemctl" "$T/curl"
  export SM_ROOT="$T/root" DOCKER="$T/docker" SYSTEMCTL="$T/systemctl" CURL="$T/curl" ATTEMPTS=2 SLEEP=0 EXPECTED_SERVICES=4
  export FAKE_CONTAINERS="a=postgres:running:healthy b=api:running:healthy c=web:running:healthy d=caddy:running:"
  export FAKE_UNITS="docker:is-active=active docker:is-enabled=enabled servermind-update.timer:is-active=active servermind-update.timer:is-enabled=enabled"
  export FAKE_HTTP=307
}
run() { bash "$SCRIPT" > "$T/out" 2>&1; echo $? > "$T/rc"; RC="$(cat "$T/rc")"; }

echo "== post-reboot-check.sh"
setup; run
check "всё в порядке → код 0 и итог" '[[ "$RC" == 0 ]] && grep -q "всё поднялось само" "$T/out" && grep -q "контейнеры ServerMind: 4 из 4" "$T/out"'
check "редирект HTTPS (307) считается ответом сайта" 'grep -q "HTTP 307" "$T/out"'
check "версия релиза показана" 'grep -q "abcdef123456" "$T/out"'

setup; export FAKE_CONTAINERS="a=postgres:running:healthy b=api:running:unhealthy c=web:running:healthy d=caddy:running:"; run
check "нездоровый контейнер → код 1 с названием" '[[ "$RC" == 1 ]] && grep -q "api=running/unhealthy" "$T/out"'

setup; export FAKE_CONTAINERS="a=postgres:running:healthy b=api:exited: c=web:running:healthy d=caddy:running:"; run
check "остановленный контейнер → код 1" '[[ "$RC" == 1 ]] && grep -q "api=exited" "$T/out"'

setup; export FAKE_CONTAINERS="a=postgres:running:healthy b=api:running:healthy"; run
check "контейнеров меньше ожидаемого → код 1" '[[ "$RC" == 1 ]] && grep -q "ожидается ≥ 4" "$T/out"'

setup; export FAKE_CONTAINERS=""; run
check "нет контейнеров вообще → код 1" '[[ "$RC" == 1 ]] && grep -q "нет контейнеров" "$T/out"'

setup; export FAKE_UNITS="docker:is-active=active docker:is-enabled=enabled servermind-update.timer:is-active=inactive servermind-update.timer:is-enabled=enabled"; run
check "таймер автообновления не активен → код 1" '[[ "$RC" == 1 ]] && grep -q "таймер servermind-update.timer НЕ активен" "$T/out"'

setup; export FAKE_UNITS="docker:is-active=active docker:is-enabled=disabled servermind-update.timer:is-active=active servermind-update.timer:is-enabled=enabled"; run
check "docker не в автозапуске → код 1 (после перезагрузки он бы не поднялся)" '[[ "$RC" == 1 ]] && grep -q "не включён в автозапуск" "$T/out"'

setup; export FAKE_HTTP=502; run
check "сайт отвечает 5xx → код 1" '[[ "$RC" == 1 ]] && grep -q "сайт не отвечает" "$T/out"'
setup; export FAKE_HTTP=000; run
check "сайт недоступен → код 1" '[[ "$RC" == 1 ]]'

setup; rm "$T/root/state/deployed.env"; run
check "нет состояния релиза → код 1" '[[ "$RC" == 1 ]] && grep -q "deployed.env" "$T/out"'

setup; echo "SERVERMIND_HTTP_PORT=8080" > "$T/root/compose/.env"; run
check "порт берётся из compose/.env" 'grep -q "127.0.0.1:8080" "$T/out"'

echo
echo "post-reboot-check.sh: пройдено $PASS, провалено $FAILN"
[[ "$FAILN" == 0 ]]
