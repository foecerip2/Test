import os
import re

import pyotp
import pytest

from app.core import security as sec
from app.modules.servers import ssh


def test_password_hash_is_argon2id_and_verifies():
    h = sec.hash_password("s3cret-pass-phrase")
    assert h.startswith("$argon2id$")
    assert sec.verify_password(h, "s3cret-pass-phrase")
    assert not sec.verify_password(h, "wrong")
    assert not sec.verify_password("not-a-hash", "x")


def test_session_token_hash_is_sha256_and_unique():
    t1, t2 = sec.new_token(), sec.new_token()
    assert t1 != t2 and len(sec.hash_token(t1)) == 64 and sec.hash_token(t1) != t1


def test_aead_roundtrip_and_context_binding():
    key = os.urandom(32)
    blob = sec.encrypt(key, b"PRIVATE", b"ctx-a")
    assert b"PRIVATE" not in blob
    assert sec.decrypt(key, blob, b"ctx-a") == b"PRIVATE"
    with pytest.raises(sec.DecryptionError):
        sec.decrypt(key, blob, b"ctx-b")  # другой контекст (другая организация) — не расшифровать
    with pytest.raises(sec.DecryptionError):
        sec.decrypt(os.urandom(32), blob, b"ctx-a")  # другой ключ
    tampered = blob[:-1] + bytes([blob[-1] ^ 1])
    with pytest.raises(sec.DecryptionError):
        sec.decrypt(key, tampered, b"ctx-a")  # данные изменены
    with pytest.raises(sec.DecryptionError):
        sec.decrypt(key, b"short", b"ctx-a")


def test_aead_nonce_is_random():
    key = os.urandom(32)
    assert sec.encrypt(key, b"x", b"a") != sec.encrypt(key, b"x", b"a")


def test_totp_window_and_replay_protection():
    secret = sec.new_totp_secret()
    now = 1_700_000_000.0
    code = pyotp.TOTP(secret).at(now)
    step = sec.verify_totp(secret, code, 0, now)
    assert step == int(now // 30)
    assert sec.verify_totp(secret, code, step, now) is None  # повтор того же кода
    assert sec.verify_totp(secret, code, 0, now + 30) == step  # допуск ±1 шаг
    assert sec.verify_totp(secret, code, 0, now + 120) is None  # слишком старый
    assert sec.verify_totp(secret, "12345", 0, now) is None and sec.verify_totp(secret, "abcdef", 0, now) is None


def test_redact_removes_secrets():
    pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3Nza\n-----END OPENSSH PRIVATE KEY-----"
    text = f"key={pem} password=hunter2 token: abc123 sk-ABCDEFGHIJKLMNOPQRSTUV Bearer abcdefghijklmnop1234"
    out = sec.redact(text)
    for leaked in ("AAAAB3Nza", "hunter2", "abc123", "sk-ABCDEFGHIJKLMNOPQRSTUV", "abcdefghijklmnop1234"):
        assert leaked not in out
    assert "[REDACTED]" in out


def test_limiter():
    lim = sec.SlidingWindowLimiter(2, 10)
    assert lim.allow("u", 0) and lim.allow("u", 1)
    assert not lim.allow("u", 2)
    assert lim.allow("v", 2)
    assert lim.allow("u", 11)  # окно прошло


# ───────── SSH: парсеры и список команд ─────────
def test_allowed_commands_are_constants_without_interpolation():
    for name, cmd in ssh.ALLOWED_COMMANDS.items():
        assert isinstance(cmd, str) and not re.search(r"[{}$`]|%s|\$\(", cmd), name
        assert "sudo" not in cmd and ">" not in cmd and "rm " not in cmd and "|" not in cmd, name


def test_parse_cpu_matches_formula_and_handles_garbage():
    assert ssh.parse_cpu("cpu  100 0 100 800 0 0 0 0 0 0\ncpu  150 0 150 900 0 0 0 0 0 0\n") == 50.0
    assert ssh.parse_cpu("") is None
    assert ssh.parse_cpu("cpu 1 2 3\n") is None
    assert ssh.parse_cpu("cpu  100 0 100 800 0\ncpu  100 0 100 800 0\n") is None  # нулевой интервал


def test_parse_missing_data_is_none_not_invented():
    assert ssh.parse_os_release("") is None
    assert ssh.parse_uptime("") is None
    assert ssh.parse_meminfo("MemTotal: 1 kB\n") == (None, None)
    assert ssh.parse_df("Filesystem\n") == (None, None)
    assert ssh.parse_services("", "") == []


def test_parse_values():
    assert ssh.parse_os_release('PRETTY_NAME="Ubuntu 24.04.1 LTS"\n') == "Ubuntu 24.04.1 LTS"
    assert ssh.parse_uptime("1566000.12 3000000.10\n") == 1566000
    assert ssh.parse_meminfo("MemTotal: 4194304 kB\nMemAvailable: 2097152 kB\n") == (2048, 4096)
    assert ssh.parse_df("Filesystem 1-blocks Used Available Capacity Mounted on\n/dev/x 42949672960 12884901888 1 30% /\n") == (12.0, 40.0)
    units = "ssh.service enabled enabled\nnginx.service enabled enabled\nfoo.service enabled enabled\n"
    assert ssh.parse_services(units, "active\ninactive\nfailed\ninactive\ninactive\ninactive\n") == [("ssh", "active"), ("nginx", "failed")]
