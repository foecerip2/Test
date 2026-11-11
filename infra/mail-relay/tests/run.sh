#!/usr/bin/env bash
# Тесты ретранслятора: php -S + фейковый SMTP (aiosmtpd). Запуск: bash infra/mail-relay/tests/run.sh
# Нужны php и python3. Окружение python создаётся ВНЕ репозитория (LH_TEST_VENV).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v php >/dev/null || { echo "нужен php"; exit 1; }
VENV="${LH_TEST_VENV:-${TMPDIR:-/tmp}/lh-mail-relay-test-venv}"
if [ ! -x "$VENV/bin/python" ]; then python3 -m venv "$VENV"; fi
"$VENV/bin/python" -c 'import aiosmtpd, pytest' 2>/dev/null || "$VENV/bin/pip" install -q aiosmtpd pytest
php -l "$HERE/../lh-mail.php"
php -l "$HERE/../lh-mail-config.sample.php"
bash -n "$HERE/../setup.sh"
exec "$VENV/bin/python" -m pytest -p no:cacheprovider -q "$HERE/test_relay.py" "$@"
