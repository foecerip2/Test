#!/usr/bin/env bash
# Репетиция восстановления БД из бэкапа (restore drill). Рабочую базу НЕ трогает: бэкап восстанавливается во ВРЕМЕННУЮ базу,
# проверяется (версия миграций, ключевые таблицы, число строк) и временная база удаляется. Бэкап, который не восстанавливается,
# — не бэкап: запускайте после установки и затем регулярно (например, раз в месяц).
#
#   sudo bash /opt/servermind/bin/restore-drill.sh                      # самый свежий бэкап из /opt/servermind/backups
#   sudo bash /opt/servermind/bin/restore-drill.sh /путь/db-….dump      # конкретный файл
# Режим local (для проверки вне Docker): DRILL_MODE=local PGHOST=… PGUSER=… PGPASSWORD=… SM_ROOT=/каталог bash restore-drill.sh
set -euo pipefail

SM_ROOT="${SM_ROOT:-/opt/servermind}"
BACKUPS="${BACKUPS:-$SM_ROOT/backups}"
MODE="${DRILL_MODE:-docker}"
DB_USER="${DRILL_DB_USER:-servermind}"
KEY_TABLES=(alembic_version organizations users memberships servers action_plans approvals audit_events)

log()  { printf '[restore-drill] %s\n' "$*"; }
die()  { printf '[restore-drill] ОШИБКА: %s\n' "$*" >&2; exit 1; }

# Выполнение команд PostgreSQL: в контейнере postgres (docker) либо напрямую (local)
pg() {
  if [[ "$MODE" == docker ]]; then
    docker compose -p servermind --project-directory "$SM_ROOT/compose" exec -T postgres "$@"
  else
    "$@"
  fi
}

DUMP="${1:-}"
if [[ -z "$DUMP" ]]; then
  DUMP="$(find "$BACKUPS" -maxdepth 1 -name 'db-*.dump' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n 1 | cut -d' ' -f2- || true)"
fi
[[ -n "$DUMP" && -s "$DUMP" ]] || die "бэкап не найден в $BACKUPS (создаётся автообновлением перед каждой миграцией)"
log "бэкап: $DUMP ($(du -h "$DUMP" | cut -f1), изменён $(date -u -r "$DUMP" +%FT%TZ))"

pg pg_restore -l < "$DUMP" >/dev/null 2>&1 || die "дамп не читается (pg_restore -l)"

TMP="servermind_drill_$(date -u +%Y%m%d%H%M%S)"
cleanup() { pg dropdb -U "$DB_USER" --if-exists "$TMP" >/dev/null 2>&1 || true; }
trap cleanup EXIT

log "создаю временную базу $TMP"
pg createdb -U "$DB_USER" "$TMP" || die "не удалось создать временную базу"
log "восстанавливаю (--no-owner --no-privileges)"
pg pg_restore -U "$DB_USER" -d "$TMP" --no-owner --no-privileges < "$DUMP" >/dev/null 2>"${TMPDIR:-/tmp}/restore-drill.err" \
  || { tail -n 5 "${TMPDIR:-/tmp}/restore-drill.err" >&2; die "pg_restore завершился с ошибкой"; }

q() { pg psql -U "$DB_USER" -d "$TMP" -Atc "$1"; }
version="$(q 'select version_num from alembic_version' | head -n 1 | tr -d '\r')"
[[ -n "$version" ]] || die "в восстановленной базе нет версии миграций (alembic_version пуста)"
tables="$(q "select count(*) from information_schema.tables where table_schema='public'" | tr -d '\r')"
for t in "${KEY_TABLES[@]}"; do
  [[ "$(q "select to_regclass('public.$t') is not null" | tr -d '\r')" == t ]] || die "нет таблицы $t"
done
log "версия миграций: $version; таблиц: $tables"
for t in organizations users servers audit_events; do
  log "  $t: $(q "select count(*) from $t" | tr -d '\r') строк"
done
# целостность журналов: триггеры append-only восстановлены вместе с данными
trig="$(q "select count(*) from pg_trigger where tgname in ('audit_events_no_update_delete','approvals_no_update_delete') and not tgisinternal" | tr -d '\r')"
[[ "$trig" == 2 ]] || die "триггеры неизменяемости журналов не восстановились (найдено $trig из 2)"
log "RESTORE DRILL OK: бэкап восстанавливается, схема и триггеры на месте. Временная база будет удалена."
