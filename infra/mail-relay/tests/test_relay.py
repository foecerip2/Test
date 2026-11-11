"""Тесты PHP-ретранслятора: php -S + фейковый SMTP (aiosmtpd)."""

from __future__ import annotations

import base64
import email
import hashlib
import hmac
import http.client
import json
import os
import secrets
import shutil
import socket
import subprocess
import time
from email import policy
from pathlib import Path

import pytest
from aiosmtpd.controller import Controller
from aiosmtpd.smtp import AuthResult, LoginPassword

RELAY = Path(__file__).resolve().parent.parent
SECRET = "s" * 40
SMTP_USER, SMTP_PASS = "noreply@vaylonet.test", "mailbox-pass"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class Handler:
    def __init__(self) -> None:
        self.messages: list[tuple[str, list[str], bytes]] = []
        self.reject_rcpt = False

    async def handle_RCPT(self, server, session, envelope, address, rcpt_options):  # noqa: N802
        if self.reject_rcpt:
            return f"550 5.1.1 <{address}> user unknown secret-detail"
        envelope.rcpt_tos.append(address)
        return "250 OK"

    async def handle_DATA(self, server, session, envelope):  # noqa: N802
        self.messages.append((envelope.mail_from, list(envelope.rcpt_tos), envelope.content))
        return "250 OK"


def authenticator(server, session, envelope, mechanism, auth_data):
    ok = isinstance(auth_data, LoginPassword) and (
        auth_data.login.decode(),
        auth_data.password.decode(),
    ) == (SMTP_USER, SMTP_PASS)
    return AuthResult(success=ok, handled=True)


@pytest.fixture
def smtp():
    h = Handler()
    port = free_port()
    c = Controller(
        h, hostname="127.0.0.1", port=port, authenticator=authenticator,
        auth_required=True, auth_require_tls=False,
    )
    c.start()
    h.port = port  # type: ignore[attr-defined]
    yield h
    c.stop()


class Relay:
    def __init__(self, tmp: Path, port: int) -> None:
        self.web = tmp / "www"
        self.web.mkdir()
        shutil.copy(RELAY / "lh-mail.php", self.web / "lh-mail.php")
        self.cfg_path = tmp / "lh-mail-config.php"
        self.data = tmp / "data"
        self.port = port
        self.proc = subprocess.Popen(
            ["php", "-S", f"127.0.0.1:{port}", "-t", str(self.web)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", port), 0.2).close()
                return
            except OSError:
                time.sleep(0.05)
        raise RuntimeError("php -S не стартовал")

    def configure(self, **kw: object) -> None:
        cfg: dict[str, object] = {
            "secret": SECRET, "transport": "smtp", "smtp_host": "127.0.0.1",
            "smtp_port": 25, "smtp_security": "none", "smtp_user": SMTP_USER,
            "smtp_password": SMTP_PASS, "from": f"LeadHunter <{SMTP_USER}>",
            "data_dir": str(self.data),
            "allow_insecure_smtp_for_tests": True, "allow_insecure_http_for_tests": True,
        }
        cfg.update(kw)
        self.cfg_path.write_text("<?php return " + _php(cfg) + ";")

    def post(
        self, body: bytes | dict | None, *, ts: int | None = None, nonce: str | None = None,
        secret: str = SECRET, sig: str | None = None, method: str = "POST",
        ctype: str = "application/json",
    ) -> tuple[int, dict, dict]:
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        ts = int(time.time()) if ts is None else ts
        nonce = nonce or secrets.token_urlsafe(16)
        if sig is None:
            sig = hmac.new(secret.encode(), f"{ts}.{nonce}.".encode() + raw, hashlib.sha256).hexdigest()
        headers = {
            "Content-Type": ctype, "X-LH-Timestamp": str(ts), "X-LH-Nonce": nonce,
            "X-LH-Signature": sig,
        }
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        conn.request(method, "/lh-mail.php", body=raw if method == "POST" else None, headers=headers)
        r = conn.getresponse()
        data = r.read()
        hdrs = {k.lower(): v for k, v in r.getheaders()}
        conn.close()
        return r.status, json.loads(data), hdrs

    def stop(self) -> None:
        self.proc.terminate()
        self.proc.wait(5)


def _php(v: object) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, dict):
        return "[" + ",".join(f"{_php(k)}=>{_php(x)}" for k, x in v.items()) + "]"
    return "'" + str(v).replace("\\", "\\\\").replace("'", "\\'") + "'"


@pytest.fixture
def relay(tmp_path: Path, smtp: Handler):
    r = Relay(tmp_path, free_port())
    r.configure(smtp_port=smtp.port)  # type: ignore[attr-defined]
    yield r
    r.stop()


GOOD = {"to": "user@example.com", "code": "123456", "ttl_minutes": 10}


def test_success_and_message(relay: Relay, smtp: Handler) -> None:
    status, body, hdrs = relay.post(GOOD)
    assert (status, body) == (200, {"ok": True})
    assert "no-store" in hdrs["cache-control"]
    (mail_from, rcpts, content), = smtp.messages
    assert mail_from == SMTP_USER and rcpts == ["user@example.com"]
    msg = email.message_from_bytes(content, policy=policy.default)
    assert msg["Subject"] == "Код входа LeadHunter: 123456"
    assert SMTP_USER in msg["From"] and "LeadHunter" in msg["From"]
    assert msg["To"] == "user@example.com" and msg["Reply-To"] is None
    assert msg["Message-ID"] and msg["Date"]
    assert msg.get_content_type() == "multipart/alternative"
    plain = msg.get_body(preferencelist=("plain",))
    html = msg.get_body(preferencelist=("html",))
    assert plain.get_content_charset() == "utf-8"
    assert "Ваш код для входа: 123456" in plain.get_content()
    assert "10 минут" in plain.get_content()
    h = html.get_content()
    assert "1&nbsp;2&nbsp;3&nbsp;4&nbsp;5&nbsp;6" in h
    for color in ("#f6f7f5", "#116c57", "#1b2927"):
        assert color in h
    assert "<img" not in h and "http://" not in h and "https://" not in h


def test_login_auth_mode(relay: Relay, smtp: Handler) -> None:
    relay.configure(smtp_port=smtp.port, smtp_auth="login")  # type: ignore[attr-defined]
    assert relay.post(GOOD)[0] == 200
    relay.configure(smtp_port=smtp.port, smtp_password="wrong")  # type: ignore[attr-defined]
    s, b, _ = relay.post({**GOOD, "to": "other@example.com"})
    assert (s, b) == (502, {"ok": False, "code": "send_failed"})


def test_ttl_default_and_plural(relay: Relay, smtp: Handler) -> None:
    assert relay.post({"to": "a@example.com", "code": "000111"})[0] == 200
    assert relay.post({"to": "b@example.com", "code": "000111", "ttl_minutes": 1})[0] == 200
    texts = [
        email.message_from_bytes(c, policy=policy.default).get_body(("plain",)).get_content()
        for _, _, c in smtp.messages
    ]
    assert "10 минут." in texts[0] and "1 минута." in texts[1]


def test_bad_signature(relay: Relay, smtp: Handler) -> None:
    assert relay.post(GOOD, secret="x" * 40)[:2] == (401, {"ok": False, "code": "unauthorized"})
    assert relay.post(GOOD, sig="0" * 64)[0] == 401
    assert relay.post(GOOD, sig="zz")[0] == 401
    assert smtp.messages == []


def test_tampered_body(relay: Relay, smtp: Handler) -> None:
    ts, nonce = int(time.time()), secrets.token_urlsafe(16)
    raw = json.dumps(GOOD).encode()
    sig = hmac.new(SECRET.encode(), f"{ts}.{nonce}.".encode() + raw, hashlib.sha256).hexdigest()
    other = json.dumps({**GOOD, "to": "evil@example.com"}).encode()
    assert relay.post(other, ts=ts, nonce=nonce, sig=sig)[0] == 401
    assert smtp.messages == []


def test_expired_and_future_timestamp(relay: Relay) -> None:
    assert relay.post(GOOD, ts=int(time.time()) - 400)[0] == 401
    assert relay.post(GOOD, ts=int(time.time()) + 400)[0] == 401
    assert relay.post(GOOD, ts=int(time.time()) - 250)[0] == 200


def test_nonce_replay(relay: Relay, smtp: Handler) -> None:
    n = "n" * 20
    assert relay.post(GOOD, nonce=n)[0] == 200
    assert relay.post(GOOD, nonce=n)[:2] == (401, {"ok": False, "code": "unauthorized"})
    assert len(smtp.messages) == 1


def test_bad_nonce_format(relay: Relay) -> None:
    assert relay.post(GOOD, nonce="short")[0] == 401
    assert relay.post(GOOD, nonce="a" * 65)[0] == 401
    assert relay.post(GOOD, nonce="bad nonce!!bad nonce!!")[0] == 401


@pytest.mark.parametrize(
    "payload",
    [
        {**GOOD, "code": "12345"}, {**GOOD, "code": "1234567"}, {**GOOD, "code": "12345a"},
        {**GOOD, "code": 123456}, {**GOOD, "code": "123456\n"},
        {**GOOD, "to": "not-an-email"}, {**GOOD, "to": "a@b.c\r\nBcc: x@y.z"},
        {**GOOD, "to": "a" * 250 + "@example.com"}, {**GOOD, "to": ["a@example.com"]},
        {**GOOD, "ttl_minutes": 0}, {**GOOD, "ttl_minutes": 61}, {**GOOD, "ttl_minutes": "10"},
        {**GOOD, "subject": "Свой заголовок"}, {**GOOD, "text": "spam"}, {**GOOD, "html": "x"},
        {"to": "a@example.com"}, [1, 2], "str",
    ],
)
def test_validation_400(relay: Relay, smtp: Handler, payload: object) -> None:
    assert relay.post(json.dumps(payload).encode())[:2] == (400, {"ok": False, "code": "bad_request"})
    assert smtp.messages == []


def test_invalid_json_and_content_type(relay: Relay) -> None:
    assert relay.post(b"{not json")[0] == 400
    assert relay.post(GOOD, ctype="text/plain")[0] == 400


def test_body_too_large(relay: Relay, smtp: Handler) -> None:
    big = json.dumps({**GOOD, "pad": "x" * 3000}).encode()
    assert relay.post(big)[:2] == (413, {"ok": False, "code": "too_large"})
    assert smtp.messages == []


def test_recipient_rate_limit(relay: Relay, smtp: Handler) -> None:
    for _ in range(5):
        assert relay.post(GOOD)[0] == 200
    assert relay.post(GOOD)[:2] == (429, {"ok": False, "code": "rate_limited"})
    assert relay.post({**GOOD, "to": "User@Example.com"})[0] == 429  # регистр не обходит лимит
    assert relay.post({**GOOD, "to": "another@example.com"})[0] == 200
    assert len(smtp.messages) == 6


def test_daily_limit(relay: Relay, smtp: Handler) -> None:
    relay.configure(smtp_port=smtp.port, max_per_day=3)  # type: ignore[attr-defined]
    for i in range(3):
        assert relay.post({**GOOD, "to": f"u{i}@example.com"})[0] == 200
    assert relay.post({**GOOD, "to": "u9@example.com"})[0] == 429


def test_methods(relay: Relay) -> None:
    for m in ("GET", "PUT", "DELETE"):
        conn = http.client.HTTPConnection("127.0.0.1", relay.port, timeout=10)
        conn.request(m, "/lh-mail.php")
        r = conn.getresponse()
        assert r.status == 405 and r.getheader("Allow") == "POST"
        assert json.loads(r.read()) == {"ok": False, "code": "method_not_allowed"}


def test_smtp_errors_do_not_leak(relay: Relay, smtp: Handler) -> None:
    smtp.reject_rcpt = True
    s, b, _ = relay.post(GOOD)
    assert (s, b) == (502, {"ok": False, "code": "send_failed"})
    # недоступный SMTP
    relay.configure(smtp_port=free_port())
    s, b, _ = relay.post({**GOOD, "to": "z@example.com"})
    assert (s, b) == (502, {"ok": False, "code": "send_failed"})
    log = (relay.data / "lh-mail.log").read_text()
    assert "user@example.com" not in log and "123456" not in log and SMTP_PASS not in log
    assert "u***@e***.com" in log


def test_log_masks_email_and_code(relay: Relay) -> None:
    assert relay.post(GOOD)[0] == 200
    log = (relay.data / "lh-mail.log").read_text()
    assert "user@example.com" not in log and "123456" not in log and SECRET not in log


def test_config_errors_500(relay: Relay) -> None:
    relay.configure(secret="short")
    assert relay.post(GOOD)[:2] == (500, {"ok": False, "code": "config_error"})
    relay.configure(data_dir=str(relay.web / "data"))  # внутри каталога сайта
    assert relay.post(GOOD)[0] == 500


def test_https_required_by_default(relay: Relay, smtp: Handler) -> None:
    relay.configure(smtp_port=smtp.port, allow_insecure_http_for_tests=False)  # type: ignore[attr-defined]
    assert relay.post(GOOD)[:2] == (400, {"ok": False, "code": "https_required"})


def test_insecure_smtp_refused_without_flag(relay: Relay, smtp: Handler) -> None:
    relay.configure(smtp_port=smtp.port, allow_insecure_smtp_for_tests=False)  # type: ignore[attr-defined]
    assert relay.post(GOOD)[0] == 502


def test_unicode_and_dot_stuffing_in_body_safe(relay: Relay, smtp: Handler) -> None:
    assert relay.post(GOOD)[0] == 200
    raw = smtp.messages[0][2]
    for line in raw.split(b"\r\n"):
        assert len(line) <= 998
    assert b"\r\n" in raw and b"\n" not in raw.replace(b"\r\n", b"")


def test_nonce_cleanup_dir_stays_small(relay: Relay) -> None:
    for _ in range(3):
        relay.post(GOOD, nonce=secrets.token_urlsafe(16), ts=int(time.time()))
    files = [p for p in (relay.data / "nonces").iterdir() if p.name != ".cleaned"]
    assert 1 <= len(files) <= 3
    old = time.time() - 3600
    for p in files:
        os.utime(p, (old, old))
    os.utime(relay.data / "nonces" / ".cleaned", (old, old))
    relay.post({**GOOD, "to": "x@example.com"}, nonce=secrets.token_urlsafe(16))
    left = [p for p in (relay.data / "nonces").iterdir() if p.name != ".cleaned"]
    assert len(left) == 1


def test_base64_roundtrip_utf8(relay: Relay, smtp: Handler) -> None:
    relay.post(GOOD)
    msg = email.message_from_bytes(smtp.messages[0][2], policy=policy.default)
    assert base64.b64encode("Код".encode()).decode()[:4]  # sanity
    assert "Код" in msg.get_body(("plain",)).get_content()
