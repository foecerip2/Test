#!/usr/bin/env bash
# Поддельный `docker` для тестов update.sh/install.sh (Docker-демона в песочнице нет).
# Поведение задаётся переменными: FAKE_LOG (куда писать вызовы), FAKE_API_DIGEST, FAKE_BUNDLE (что отдаёт `docker cp`),
# FAKE_FAIL (список через запятую: pull, webpull, backup, badbackup, migrate, smoke, create, cp), FAKE_BAD_API (digest, на котором падает smoke).
set -u
printf '%s\n' "docker $*" >> "${FAKE_LOG:?}"
fail() { [[ ",${FAKE_FAIL:-}," == *",$1,"* ]]; }

case "${1:-}" in
  pull)
    ref="${*: -1}"
    if [[ "$ref" == *-web@* ]] && fail webpull; then exit 1; fi
    if [[ "$ref" == *-api:* ]] && fail pull; then exit 1; fi
    exit 0 ;;
  image)
    case "${2:-}" in
      inspect) echo "${FAKE_API_DIGEST:-}"; exit 0 ;;
      prune) exit 0 ;;
    esac ;;
  create) fail create && exit 1; echo "fakecid"; exit 0 ;;
  cp)
    fail cp && exit 1
    dest="${*: -1}"; mkdir -p "$dest"; cp -r "${FAKE_BUNDLE:?}/." "$dest/"; exit 0 ;;
  rm) exit 0 ;;
  inspect) echo true; exit 0 ;;
  compose)
    shift
    projdir=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --project-name|--env-file|-f|--profile) shift 2 ;;
        --project-directory) projdir="$2"; shift 2 ;;
        *) break ;;
      esac
    done
    sub="${1:-}"; shift || true
    case "$sub" in
      config)
        grep -q INVALID "$projdir/docker-compose.yml" 2>/dev/null && exit 1
        exit 0 ;;
      exec)
        # exec -T <service> <cmd...>
        [[ "${1:-}" == "-T" ]] && shift
        svc="${1:-}"; shift || true
        case "$svc:${1:-}" in
          postgres:pg_dump) fail backup && exit 1; echo "PGDMP-fake-dump"; exit 0 ;;
          postgres:pg_restore) cat >/dev/null; fail badbackup && exit 1; exit 0 ;;
          api:*|web:*)
            fail smoke_all && exit 1   # проверка падает всегда — и для нового релиза, и при откате
            if fail smoke; then
              cur="$(sed -n 's/^SERVERMIND_API_IMAGE=//p' "$projdir/.env" | tail -n 1)"
              [[ "$cur" == "${FAKE_BAD_API:-__none__}" ]] && exit 1
            fi
            exit 0 ;;
        esac ;;
      run) fail migrate && exit 1; exit 0 ;;
      up) exit 0 ;;
      ps) echo "fakecaddy"; exit 0 ;;
    esac ;;
esac
exit 0
