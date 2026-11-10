#!/usr/bin/env bash
# Тесты update.sh на поддельном docker: проверяют ЛОГИКУ обновления/отката. Реальный Docker не используется.
# shellcheck disable=SC2016  # условия check передаются строками и вычисляются через eval — одинарные кавычки намеренные
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPDATE="$HERE/../update.sh"
FAKE="$HERE/fake_docker.sh"
chmod +x "$FAKE"
PASS=0; FAILN=0

ok()   { PASS=$((PASS + 1)); printf '  PASS  %s\n' "$1"; }
bad()  { FAILN=$((FAILN + 1)); printf '  FAIL  %s\n' "$1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

OLD_API="ghcr.io/o/servermind-api@sha256:old"
NEW_API="ghcr.io/o/servermind-api@sha256:new"
OLD_WEB="ghcr.io/o/servermind-web@sha256:oldweb"
NEW_WEB="ghcr.io/o/servermind-web@sha256:newweb"

setup() { # создаёт изолированный /opt/servermind и «релиз» на канале
  T="$(mktemp -d)"
  export SM_ROOT="$T/sm" FAKE_LOG="$T/docker.log" FAKE_BUNDLE="$T/bundle" FAKE_API_DIGEST="$NEW_API"
  export FAKE_FAIL="" FAKE_BAD_API="$NEW_API" DOCKER="$FAKE" SMOKE_TIMEOUT=2 SMOKE_INTERVAL=1 DISK_MIN_FREE_MB=1 SM_NO_SYSLOG=1 KEEP_BACKUPS=3
  S="$SM_ROOT/state"; C="$SM_ROOT/compose"
  mkdir -p "$S" "$C" "$SM_ROOT/bin" "$FAKE_BUNDLE/infra/compose" "$FAKE_BUNDLE/infra/caddy" "$FAKE_BUNDLE/bootstrap"
  printf 'SM_IMAGE_REPO=ghcr.io/o/servermind\nSM_CHANNEL=stable\n' > "$S/config"
  printf 'API=%s\nWEB=%s\nCOMMIT=oldcommit\n' "$OLD_API" "$OLD_WEB" > "$S/deployed.env"
  printf 'services: {old: true}\n' > "$C/docker-compose.yml"; printf 'old-caddy\n' > "$C/Caddyfile"
  printf 'SERVERMIND_API_IMAGE=%s\nSERVERMIND_WEB_IMAGE=%s\nSERVERMIND_HTTP_PORT=80\n' "$OLD_API" "$OLD_WEB" > "$C/.env"
  printf 'services: {new: true}\n' > "$FAKE_BUNDLE/infra/compose/docker-compose.yml"; printf 'new-caddy\n' > "$FAKE_BUNDLE/infra/caddy/Caddyfile"
  printf '#!/usr/bin/env bash\n# NEW-UPDATER\n' > "$FAKE_BUNDLE/bootstrap/update.sh"
  printf '{"commit":"abc123","web":"%s"}\n' "$NEW_WEB" > "$FAKE_BUNDLE/release.json"
  printf '#!/usr/bin/env bash\n# OLD-UPDATER\n' > "$SM_ROOT/bin/update.sh"
}
run() { bash "$UPDATE" > "$T/out.log" 2>&1; echo $? > "$T/rc"; RC="$(cat "$T/rc")"; export RC; }
log_has() { grep -q -- "$1" "$FAKE_LOG" 2>/dev/null; }
env_val() { sed -n "s/^$2=//p" "$1" | tail -n 1; }
status() { sed -n 's/.*"result":"\([^"]*\)".*/\1/p' "$S/last-update.json" 2>/dev/null; }
count_up() { grep -c 'compose.* up -d' "$FAKE_LOG" 2>/dev/null || true; }

echo "== 1. нет изменений на канале → ничего не делает"
setup; export FAKE_API_DIGEST="$OLD_API"; run
check "код 0" '[[ "$RC" == 0 ]]'
check "не создавал контейнеров и не запускал compose" '! log_has "docker create" && ! log_has "compose"'
check "состояние не изменилось" '[[ "$(env_val "$S/deployed.env" API)" == "$OLD_API" ]]'

echo "== 2. новый релиз → бэкап, миграции, запуск по digest, smoke, состояние"
setup; run
check "код 0" '[[ "$RC" == 0 ]]'
check "статус ok" '[[ "$(status)" == ok ]]'
check "сделан читаемый бэкап БД" '[[ -s "$(ls "$SM_ROOT"/backups/db-*.dump | head -1)" ]] && log_has "pg_restore -l"'
check "миграции запущены ДО up -d" '[[ "$(grep -n "run --rm migrate" "$FAKE_LOG" | head -1 | cut -d: -f1)" -lt "$(grep -n " up -d" "$FAKE_LOG" | head -1 | cut -d: -f1)" ]]'
check "бэкап сделан ДО миграций" '[[ "$(grep -n pg_dump "$FAKE_LOG" | head -1 | cut -d: -f1)" -lt "$(grep -n "migrate" "$FAKE_LOG" | head -1 | cut -d: -f1)" ]]'
check "образы переключены по digest" '[[ "$(env_val "$C/.env" SERVERMIND_API_IMAGE)" == "$NEW_API" && "$(env_val "$C/.env" SERVERMIND_WEB_IMAGE)" == "$NEW_WEB" ]]'
check "другие переменные .env сохранены" '[[ "$(env_val "$C/.env" SERVERMIND_HTTP_PORT)" == 80 ]]'
check "новые compose/Caddyfile установлены" 'grep -q "new: true" "$C/docker-compose.yml" && grep -q new-caddy "$C/Caddyfile"'
check "deployed.env обновлён" '[[ "$(env_val "$S/deployed.env" API)" == "$NEW_API" && "$(env_val "$S/deployed.env" COMMIT)" == abc123 ]]'
check "update.sh самообновился" 'grep -q NEW-UPDATER "$SM_ROOT/bin/update.sh"'
check "веб-образ скачан по digest" 'log_has "pull -q $NEW_WEB"'
echo "-- скрипты эксплуатации из релиза доставляются на сервер (если есть в пакете), без них обновление не ломается"
setup; printf '#!/usr/bin/env bash\n# NEW-DRILL\n' > "$FAKE_BUNDLE/bootstrap/restore-drill.sh"; printf '#!/usr/bin/env bash\n# NEW-POSTCHECK\n' > "$FAKE_BUNDLE/bootstrap/post-reboot-check.sh"; run
check "restore-drill.sh и post-reboot-check.sh установлены, исполняемые" '[[ "$RC" == 0 && "$(status)" == ok ]] && grep -q NEW-DRILL "$SM_ROOT/bin/restore-drill.sh" && grep -q NEW-POSTCHECK "$SM_ROOT/bin/post-reboot-check.sh" && [[ -x "$SM_ROOT/bin/restore-drill.sh" && -x "$SM_ROOT/bin/post-reboot-check.sh" ]]'
setup; run
check "релиз без этих скриптов: обновление проходит, лишнего не создаётся" '[[ "$RC" == 0 && "$(status)" == ok && ! -e "$SM_ROOT/bin/restore-drill.sh" ]]'
echo "-- повторный запуск того же релиза: no-op"
: > "$FAKE_LOG"; export FAKE_API_DIGEST="$NEW_API"; run
check "ничего не делает" '[[ "$RC" == 0 ]] && ! log_has "compose"'

echo "== 3. smoke-тест не прошёл → откат и запрет повторять сломанный релиз"
setup; export FAKE_FAIL="smoke"; run
check "код 1 (юнит помечается failed)" '[[ "$RC" == 1 ]]'
check "статус rolled_back" '[[ "$(status)" == rolled_back ]]'
check "образы возвращены на прежние" '[[ "$(env_val "$C/.env" SERVERMIND_API_IMAGE)" == "$OLD_API" && "$(env_val "$C/.env" SERVERMIND_WEB_IMAGE)" == "$OLD_WEB" ]]'
check "прежние compose/Caddyfile восстановлены" 'grep -q "old: true" "$C/docker-compose.yml" && grep -q old-caddy "$C/Caddyfile"'
check "состояние deployed.env не тронуто" '[[ "$(env_val "$S/deployed.env" API)" == "$OLD_API" ]]'
check "сломанный digest запомнен" '[[ "$(env_val "$S/failed.env" FAILED_API)" == "$NEW_API" ]]'
check "up -d вызван дважды (новый, затем откат)" '[[ "$(count_up)" == 2 ]]'
: > "$FAKE_LOG"; run
check "тот же сломанный релиз не повторяется" '[[ "$RC" == 0 ]] && ! log_has "compose"'
echo "-- выходит новый релиз после сломанного → снова обновляемся"
export FAKE_API_DIGEST="ghcr.io/o/servermind-api@sha256:newer" FAKE_FAIL="" FAKE_BAD_API="x"; : > "$FAKE_LOG"; run
check "обновился на новый" '[[ "$RC" == 0 && "$(status)" == ok && "$(env_val "$S/deployed.env" API)" == *newer ]]'
check "failed.env очищен" '[[ -z "$(env_val "$S/failed.env" FAILED_API)" ]]'

echo "== 3a. ошибка Compose или прежний web при живых эндпоинтах → откат"
for failure in up stale_web; do
  setup; export FAKE_FAIL="$failure" FAKE_OLD_WEB="$OLD_WEB"
  printf '%s true\n' "$OLD_API" > "$FAKE_LOG.fakeapi"
  printf '%s true\n' "$OLD_WEB" > "$FAKE_LOG.fakeweb"
  run
  check "$failure: новый релиз не отмечен успешным" '[[ "$RC" != 0 && "$(status)" == rolled_back && "$(env_val "$S/deployed.env" COMMIT)" == oldcommit ]]'
done

echo "== 4. откат тоже не прошёл → rollback_failed"
setup; export FAKE_FAIL="smoke_all"; run
check "статус rollback_failed и код 1 (требуется человек)" '[[ "$(status)" == rollback_failed && "$RC" == 1 ]]'
check "сообщение прямо говорит о ручном вмешательстве" 'grep -q "ручное вмешательство" "$S/last-update.json"'

echo "== 5. миграции упали → сервисы не перезапускались, конфиг восстановлен"
setup; export FAKE_FAIL="migrate"; run
check "статус migration_failed, код 1" '[[ "$(status)" == migration_failed && "$RC" == 1 ]]'
check "up -d не вызывался" '[[ "$(count_up)" == 0 ]]'
check "образы и конфиг прежние" '[[ "$(env_val "$C/.env" SERVERMIND_API_IMAGE)" == "$OLD_API" ]] && grep -q "old: true" "$C/docker-compose.yml"'
check "бэкап остался" 'ls "$SM_ROOT"/backups/db-*.dump >/dev/null 2>&1'
check "релиз помечен сломанным" '[[ "$(env_val "$S/failed.env" FAILED_API)" == "$NEW_API" ]]'

echo "== 6. бэкап не удался (или нечитаем) → обновление отменено до любых изменений"
setup; export FAKE_FAIL="backup"; run
check "статус backup_failed, код 1" '[[ "$(status)" == backup_failed && "$RC" == 1 ]]'
check "миграции и up не запускались" '! log_has "migrate" && [[ "$(count_up)" == 0 ]]'
check "образы прежние" '[[ "$(env_val "$C/.env" SERVERMIND_API_IMAGE)" == "$OLD_API" ]]'
setup; export FAKE_FAIL="badbackup"; run
check "нечитаемый дамп тоже блокирует (и удаляется)" '[[ "$(status)" == backup_failed ]] && ! ls "$SM_ROOT"/backups/db-*.dump >/dev/null 2>&1'

echo "== 7. невалидный compose в релизе → восстановление и пропуск"
setup; printf 'INVALID\n' > "$FAKE_BUNDLE/infra/compose/docker-compose.yml"; run
check "статус bad_compose" '[[ "$(status)" == bad_compose && "$RC" == 1 ]]'
check "старый compose на месте, migrate не запускался" 'grep -q "old: true" "$C/docker-compose.yml" && ! log_has "migrate"'

echo "== 8. неполный пакет развёртывания / release.json без digest веб-образа"
setup; rm -f "$FAKE_BUNDLE/infra/caddy/Caddyfile"; run
check "статус bad_bundle" '[[ "$(status)" == bad_bundle && "$RC" == 1 ]] && ! log_has "compose"'
setup; printf '{"commit":"x","web":"ghcr.io/o/servermind-web:latest"}\n' > "$FAKE_BUNDLE/release.json"; run
check "веб без digest отвергается (только неизменяемые ссылки)" '[[ "$(status)" == bad_bundle ]]'

echo "== 9. сеть/реестр недоступны → не ошибка, состояние не меняется"
setup; export FAKE_FAIL="pull"; run
check "код 0, ничего не запущено" '[[ "$RC" == 0 ]] && ! log_has "compose" && [[ "$(env_val "$S/deployed.env" API)" == "$OLD_API" ]]'
setup; export FAKE_FAIL="webpull"; run
check "веб-образ не скачался → без изменений (повтор позже)" '[[ "$RC" == 0 ]] && ! log_has "compose"'
setup; export FAKE_FAIL="create"; run
check "не создаётся контейнер из образа → без изменений" '[[ "$RC" == 0 ]] && ! log_has "compose"'

echo "== 10. мало места на диске → обновление откладывается"
setup; export DISK_MIN_FREE_MB=999999999; run
check "статус skipped_disk, ничего не скачивалось" '[[ "$(status)" == skipped_disk && "$RC" == 0 ]] && ! log_has "pull"'

echo "== 11. пауза и режим обслуживания"
setup; touch "$S/auto-update.disabled"; run
check "auto-update.disabled → ничего не делает" '[[ "$RC" == 0 ]] && [[ ! -s "$FAKE_LOG" ]]'
setup; touch "$S/maintenance.lock"; run
check "maintenance.lock → ничего не делает" '[[ "$RC" == 0 ]] && [[ ! -s "$FAKE_LOG" ]]'

echo "== 12. параллельный запуск блокируется"
setup; ( exec 8> "$S/update.lock"; flock 8; sleep 3 ) & HOLDER=$!; sleep 0.5; run; wait "$HOLDER" 2>/dev/null
check "второй экземпляр не работает" '[[ "$RC" == 0 ]] && [[ ! -s "$FAKE_LOG" ]] && grep -q "уже выполняется" "$T/out.log"'

echo "== 13. не установлено / нет конфигурации"
setup; rm -f "$S/config"; run
check "код 1 с понятным сообщением" '[[ "$RC" == 1 ]] && grep -q "установка не выполнена" "$T/out.log"'

echo "== 14. ротация бэкапов хранит последние N"
setup; mkdir -p "$SM_ROOT/backups"; for i in 1 2 3 4 5; do : > "$SM_ROOT/backups/db-2020010${i}T000000Z.dump"; touch -d "2020-01-0${i}" "$SM_ROOT/backups/db-2020010${i}T000000Z.dump"; done
run
check "осталось KEEP_BACKUPS=3, самый новый сохранён" '[[ "$(ls "$SM_ROOT"/backups/db-*.dump | wc -l)" == 3 ]] && ls "$SM_ROOT"/backups/db-2*.dump | grep -q "$(date -u +%Y)"'

echo "== 15. статус и права"
setup; run
check "last-update.json содержит digest и коммит" 'grep -q "\"api\":\"$NEW_API\"" "$S/last-update.json" && grep -q "\"commit\":\"abc123\"" "$S/last-update.json"'
check "бэкапы с правами 600, каталог 700" '[[ "$(stat -c %a "$SM_ROOT"/backups)" == 700 && "$(stat -c %a "$(ls "$SM_ROOT"/backups/db-*.dump | head -1)")" == 600 ]]'
check "временный stage удалён" '! ls -d "$S"/stage.* >/dev/null 2>&1'

echo
echo "update.sh: пройдено $PASS, провалено $FAILN"
[[ "$FAILN" == 0 ]]
