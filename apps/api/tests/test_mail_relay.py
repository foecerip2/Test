"""HttpRelayMailer: подпись, тело запроса, ошибки, конфигурация, отсутствие секрета в логах."""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import socket
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import pytest

from app.cli import main as cli_main
from app.config import Settings
from app.mail import HttpRelayMailer, MailError, make_mailer, sign_relay_request

SECRET = "r" * 40
BASE: dict[str, Any] = {
    "env": "dev",
    "secret_key": "test-secret-key-0123456789-0123456789",
    "mail_backend": "http",
    "mail_relay_secret": SECRET,
}


class Recorder:
    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.status = 200
        self.body: bytes = b'{"ok":true}'
        self.delay = 0.0
        self.location: str | None = None


@pytest.fixture
def relay_server() -> Iterator[tuple[str, Recorder]]:
    rec = Recorder()

    class H(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            n = int(self.headers.get("Content-Length", "0"))
            rec.requests.append(
                {"path": self.path, "headers": dict(self.headers), "body": self.rfile.read(n)}
            )
            if rec.delay:
                threading.Event().wait(rec.delay)
            self.send_response(rec.status)
            if rec.location:
                self.send_header("Location", rec.location)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(rec.body)

        def log_message(self, *a: object) -> None:
            return None

    srv = HTTPServer(("127.0.0.1", 0), H)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/lh-mail.php", rec
    srv.shutdown()


def _mailer(url: str) -> HttpRelayMailer:
    return HttpRelayMailer(Settings(**BASE, mail_relay_url=url))


def test_signature_known_vector() -> None:
    # Вектор для схемы HMAC-SHA256(secret, ts + "." + nonce + "." + body); тот же считает PHP.
    sig = sign_relay_request("k" * 32, "1700000000", "nonce1234567890ab", b'{"a":1}')
    # значение посчитано независимо через PHP hash_hmac
    assert sig == "d43431e914f3665258173c1bb371d8a8c92b1fa824c1355ca2921321a23da9c3"
    assert (
        sig
        == hmac.new(b"k" * 32, b'1700000000.nonce1234567890ab.{"a":1}', hashlib.sha256).hexdigest()
    )


def test_request_shape_and_signature(relay_server: tuple[str, Recorder]) -> None:
    url, rec = relay_server
    _mailer(url).send_otp("user@example.com", "123456", 10)
    (req,) = rec.requests
    assert req["path"] == "/lh-mail.php"
    assert json.loads(req["body"]) == {
        "to": "user@example.com",
        "code": "123456",
        "ttl_minutes": 10,
    }
    h = {k.lower(): v for k, v in req["headers"].items()}
    assert h["content-type"] == "application/json"
    assert 16 <= len(h["x-lh-nonce"]) <= 64
    assert h["x-lh-signature"] == sign_relay_request(
        SECRET, h["x-lh-timestamp"], h["x-lh-nonce"], req["body"]
    )
    assert SECRET not in json.dumps({k: str(v) for k, v in req["headers"].items()})


def test_nonce_unique(relay_server: tuple[str, Recorder]) -> None:
    url, rec = relay_server
    m = _mailer(url)
    m.send_otp("a@example.com", "111111", 10)
    m.send_otp("a@example.com", "111111", 10)
    nonces = {r["headers"]["X-LH-Nonce"] for r in rec.requests}
    assert len(nonces) == 2


@pytest.mark.parametrize(
    ("status", "body"),
    [
        (401, b'{"ok":false,"code":"unauthorized"}'),
        (429, b'{"ok":false,"code":"rate_limited"}'),
        (502, b'{"ok":false,"code":"send_failed"}'),
        (200, b"<html>not json</html>"),
        (200, b'{"ok":false}'),
        (200, b'["ok"]'),
        (500, b""),
    ],
)
def test_bad_responses_raise(relay_server: tuple[str, Recorder], status: int, body: bytes) -> None:
    url, rec = relay_server
    rec.status, rec.body = status, body
    with pytest.raises(MailError):
        _mailer(url).send_otp("a@example.com", "123456", 10)


def test_redirect_not_followed(relay_server: tuple[str, Recorder]) -> None:
    url, rec = relay_server
    rec.status, rec.location = 302, url + "?again=1"
    with pytest.raises(MailError):
        _mailer(url).send_otp("a@example.com", "123456", 10)
    assert len(rec.requests) == 1


def test_connection_refused_raises() -> None:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    with pytest.raises(MailError):
        _mailer(f"http://127.0.0.1:{port}/x").send_otp("a@example.com", "123456", 10)


def test_timeout_raises(
    monkeypatch: pytest.MonkeyPatch, relay_server: tuple[str, Recorder]
) -> None:
    import app.mail as mail

    url, rec = relay_server
    rec.delay = 1.0
    monkeypatch.setattr(mail, "RELAY_TIMEOUT", 0.2)
    with pytest.raises(MailError):
        _mailer(url).send_otp("a@example.com", "123456", 10)


def test_timeout_is_15_seconds() -> None:
    import app.mail as mail

    assert mail.RELAY_TIMEOUT == 15


def test_https_uses_verifying_context(monkeypatch: pytest.MonkeyPatch) -> None:
    import ssl

    import app.mail as mail

    seen: dict[str, Any] = {}

    class Fake:
        def __init__(self, host: str, port: int | None, timeout: float, context: Any) -> None:
            seen.update(host=host, port=port, timeout=timeout, context=context)

        def request(self, *a: Any, **k: Any) -> None:
            seen["called"] = True

        def getresponse(self) -> Any:
            class R:
                status = 200

                def read(self, n: int) -> bytes:
                    return b'{"ok":true}'

            return R()

        def close(self) -> None:
            return None

    monkeypatch.setattr(mail.http.client, "HTTPSConnection", Fake)
    _mailer("https://vaylonet.ru/lh-mail.php").send_otp("a@example.com", "123456", 10)
    ctx = seen["context"]
    assert seen["host"] == "vaylonet.ru" and seen["timeout"] == 15
    assert ctx.verify_mode == ssl.CERT_REQUIRED and ctx.check_hostname is True


def test_send_raises_for_arbitrary_message() -> None:
    with pytest.raises(MailError):
        _mailer("http://127.0.0.1:1/x").send("a@example.com", "s", "t", "h")


def test_logs_have_no_secret_code_or_full_email(
    relay_server: tuple[str, Recorder], caplog: pytest.LogCaptureFixture
) -> None:
    url, rec = relay_server
    rec.status, rec.body = 401, b'{"ok":false,"code":"unauthorized"}'
    with caplog.at_level(logging.DEBUG), pytest.raises(MailError):
        _mailer(url).send_otp("alice@example.com", "424242", 10)
    assert SECRET not in caplog.text and "424242" not in caplog.text
    assert "alice@example.com" not in caplog.text and "a***@e***.com" in caplog.text


def test_secret_not_in_repr_and_make_mailer() -> None:
    s = Settings(**BASE, mail_relay_url="https://vaylonet.ru/lh-mail.php")
    assert SECRET not in repr(s) and SECRET not in str(s)
    m = make_mailer(s)
    assert isinstance(m, HttpRelayMailer) and SECRET not in repr(m)


# ---- конфигурация ----
PROD: dict[str, Any] = {
    "env": "prod",
    "secret_key": "k" * 40,
    "database_url": "postgresql://u:p@db/lh",
    "mail_backend": "http",
}


def test_config_http_requires_url_and_secret() -> None:
    with pytest.raises(ValueError, match="MAIL_RELAY_URL"):
        Settings(**PROD, mail_relay_secret=SECRET)
    with pytest.raises(ValueError, match="MAIL_RELAY_SECRET"):
        Settings(**PROD, mail_relay_url="https://vaylonet.ru/lh-mail.php")
    with pytest.raises(ValueError, match="MAIL_RELAY_SECRET"):
        Settings(**PROD, mail_relay_url="https://vaylonet.ru/x.php", mail_relay_secret="short")
    ok = Settings(
        **PROD, mail_relay_url="https://vaylonet.ru/lh-mail.php", mail_relay_secret=SECRET
    )
    assert ok.mail_backend == "http"


def test_config_prod_requires_https() -> None:
    with pytest.raises(ValueError, match="https"):
        Settings(**PROD, mail_relay_url="http://vaylonet.ru/lh-mail.php", mail_relay_secret=SECRET)
    # в dev http допустим (локальные тесты)
    Settings(**BASE, mail_relay_url="http://127.0.0.1:8080/lh-mail.php")


@pytest.mark.parametrize(
    "url", ["ftp://x/y", "https:///nohost", "https://u:p@h.ru/x", "vaylonet.ru"]
)
def test_config_rejects_bad_urls(url: str) -> None:
    with pytest.raises(ValueError, match="MAIL_RELAY_URL"):
        Settings(**PROD, mail_relay_url=url, mail_relay_secret=SECRET)


def test_config_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MAIL_BACKEND", "http")
    monkeypatch.setenv("MAIL_RELAY_URL", "https://vaylonet.ru/lh-mail.php")
    monkeypatch.setenv("MAIL_RELAY_SECRET", SECRET)
    s = Settings()
    assert s.mail_relay_url.endswith("lh-mail.php") and s.mail_relay_secret == SECRET


# ---- CLI ----
def test_cli_send_test_mail_http(
    relay_server: tuple[str, Recorder],
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    url, rec = relay_server
    monkeypatch.setenv("MAIL_BACKEND", "http")
    monkeypatch.setenv("MAIL_RELAY_URL", url)
    monkeypatch.setenv("MAIL_RELAY_SECRET", SECRET)
    assert cli_main(["send-test-mail", "me@example.com"]) == 0
    out = capsys.readouterr()
    assert "Тестовый код отправлен" in out.out and SECRET not in out.out + out.err
    payload = json.loads(rec.requests[0]["body"])
    assert payload["to"] == "me@example.com" and len(payload["code"]) == 6
    assert payload["code"].isdigit() and payload["code"] not in out.out


def test_cli_send_test_mail_http_failure(
    relay_server: tuple[str, Recorder],
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    url, rec = relay_server
    rec.status, rec.body = 401, b'{"ok":false,"code":"unauthorized"}'
    monkeypatch.setenv("MAIL_BACKEND", "http")
    monkeypatch.setenv("MAIL_RELAY_URL", url)
    monkeypatch.setenv("MAIL_RELAY_SECRET", SECRET)
    assert cli_main(["send-test-mail", "me@example.com"]) == 1
    assert "Не удалось" in capsys.readouterr().err
