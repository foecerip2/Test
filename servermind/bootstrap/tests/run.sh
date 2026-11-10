#!/usr/bin/env bash
# Запуск всех тестов bootstrap (установщик + автообновление). Требования: bash, util-linux (flock). Docker НЕ нужен.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
rc=0
for t in test_update.sh test_install.sh test_postcheck.sh; do
  echo "################ $t"
  bash "$HERE/$t" || rc=1
done
if command -v shellcheck >/dev/null 2>&1; then
  echo "################ shellcheck"
  shellcheck -x "$HERE/../update.sh" "$HERE/../install.sh" "$HERE"/*.sh && echo "shellcheck: чисто" || rc=1
else
  echo "(shellcheck не установлен — статический анализ пропущен)"
fi
exit "$rc"
