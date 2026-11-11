"""Письма, SMTP-транспорт, CLI, конфигурация."""

from __future__ import annotations

import email
import logging
import smtplib
from email import policy
from email.message import EmailMessage
from typing import Any

import pytest

from app.cli import main as cli_main
from app.config import Settings
from app.mail import ConsoleMailer, MailError, SmtpMailer, render_otp_email


def _smtp_settings(**kw: Any) -> Settings:
    values: dict[str, Any] = {
        "env": "dev",
        "secret_key": "test-secret-key-0123456789-0123456789",
        "mail_backend": "smtp",
        "smtp_host": "smtp.example.com",
        "smtp_port": 465,
        "smtp_user": "noreply@example.com",
        "smtp_password": "pw",
        "smtp_from": "LeadHunter <noreply@example.com>",
    }
    values.update(kw)
    return Settings(**values)


class FakeSMTP:
    instances: list[FakeSMTP] = []
    fail_connect = False

    def __init__(self, host: str, port: int, timeout: float | None = None, **kw: Any) -> None:
        if FakeSMTP.fail_connect:
            raise OSError("connection refused")
        self.host, self.port, self.timeout, self.kw = host, port, timeout, kw
        self.started_tls = False
        self.logged_in: tuple[str, str] | None = None
        self.sent: list[tuple[EmailMessage, str, list[str]]] = []
        FakeSMTP.instances.append(self)

    def __enter__(self) -> FakeSMTP:
        return self

    def __exit__(self, *a: object) -> None:
        return None

    def starttls(self, **kw: Any) -> None:
        self.started_tls = True

    def login(self, u: str, p: str) -> None:
        self.logged_in = (u, p)

    def send_message(
        self, msg: EmailMessage, from_addr: str, to_addrs: list[str]
    ) -> dict[str, Any]:
        self.sent.append((msg, from_addr, to_addrs))
        return {}


@pytest.fixture
def fake_smtp(monkeypatch: pytest.MonkeyPatch) -> type[FakeSMTP]:
    FakeSMTP.instances = []
    FakeSMTP.fail_connect = False
    monkeypatch.setattr(smtplib, "SMTP_SSL", FakeSMTP)
    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)
    return FakeSMTP


def test_render_email_content() -> None:
    subject, text, html = render_otp_email("123456")
    assert subject == "Код входа LeadHunter: 123456"
    assert "123456" in text and "Код действует 10 минут" in text
    assert "1&nbsp;2&nbsp;3&nbsp;4&nbsp;5&nbsp;6" in html
    for color in ("#f6f7f5", "#116c57", "#1b2927"):
        assert color in html
    assert "Если вы не запрашивали вход — просто проигнорируйте письмо" in html
    assert "<img" not in html and "http://" not in html and "https://" not in html


def test_smtp_ssl_message_structure(fake_smtp: type[FakeSMTP]) -> None:
    s = _smtp_settings()
    subject, text, html = render_otp_email("654321")
    SmtpMailer(s).send("user@example.com", subject, text, html)
    srv = fake_smtp.instances[0]
    assert (srv.host, srv.port, srv.timeout) == ("smtp.example.com", 465, 15)
    assert srv.logged_in == ("noreply@example.com", "pw")
    msg, from_addr, to_addrs = srv.sent[0]
    assert from_addr == "noreply@example.com" and to_addrs == ["user@example.com"]
    parsed = email.message_from_bytes(msg.as_bytes(), policy=policy.default)
    assert parsed["Subject"] == "Код входа LeadHunter: 654321"
    assert "noreply@example.com" in parsed["From"] and parsed["To"] == "user@example.com"
    assert parsed.get_content_type() == "multipart/alternative"
    types = [p.get_content_type() for p in parsed.iter_parts()]
    assert types == ["text/plain", "text/html"]
    plain = parsed.get_body(preferencelist=("plain",))
    assert plain is not None and "654321" in plain.get_content()


def test_smtp_starttls(fake_smtp: type[FakeSMTP]) -> None:
    s = _smtp_settings(smtp_port=587)
    assert s.smtp_security_effective == "starttls"
    SmtpMailer(s).send("u@example.com", "s", "t", "<p>h</p>")
    assert fake_smtp.instances[0].started_tls is True


def test_smtp_security_none_without_login(fake_smtp: type[FakeSMTP]) -> None:
    s = _smtp_settings(smtp_port=25, smtp_security="none", smtp_user="")
    SmtpMailer(s).send("u@example.com", "s", "t", "<p>h</p>")
    srv = fake_smtp.instances[0]
    assert srv.logged_in is None and srv.started_tls is False


def test_smtp_failure_raises_mail_error(fake_smtp: type[FakeSMTP]) -> None:
    fake_smtp.fail_connect = True
    with pytest.raises(MailError):
        SmtpMailer(_smtp_settings()).send("u@example.com", "s", "t", "<p>h</p>")


def test_smtp_failure_log_has_no_code_or_full_email(
    fake_smtp: type[FakeSMTP], caplog: pytest.LogCaptureFixture
) -> None:
    fake_smtp.fail_connect = True
    subject, text, html = render_otp_email("424242")
    with caplog.at_level(logging.DEBUG), pytest.raises(MailError):
        SmtpMailer(_smtp_settings()).send("alice@example.com", subject, text, html)
    assert "424242" not in caplog.text and "alice@example.com" not in caplog.text
    assert "a***@e***.com" in caplog.text


def test_console_mailer_forbidden_in_prod() -> None:
    with pytest.raises(ValueError, match="console"):
        Settings(
            env="prod",
            secret_key="x" * 40,
            database_url="postgresql://u:p@db/lh",
            mail_backend="console",
        )
    prod_like = Settings.model_construct(env="prod", mail_backend="console")
    with pytest.raises(RuntimeError):
        ConsoleMailer(prod_like)


def test_console_mailer_logs_code_in_dev(caplog: pytest.LogCaptureFixture) -> None:
    s = Settings(env="dev", mail_backend="console")
    subject, text, html = render_otp_email("111222")
    with caplog.at_level(logging.WARNING):
        ConsoleMailer(s).send("a@example.com", subject, text, html)
    assert "111222" in caplog.text and "a@example.com" not in caplog.text


def test_prod_requires_strong_secret() -> None:
    base: dict[str, Any] = {
        "env": "prod",
        "database_url": "postgresql://u:p@db/lh",
        "mail_backend": "smtp",
        "smtp_host": "smtp.example.com",
    }
    with pytest.raises(ValueError, match="SECRET_KEY"):
        Settings(**base, secret_key="short")
    with pytest.raises(ValueError, match="SECRET_KEY"):
        Settings(**base)  # dev-ключ по умолчанию запрещён
    ok = Settings(**base, secret_key="k" * 32)
    assert ok.cookie_secure_effective is True
    assert ok.database_url.startswith("postgresql+psycopg://")


def test_cli_send_test_mail_ok(
    fake_smtp: type[FakeSMTP], monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    for k, v in {
        "MAIL_BACKEND": "smtp",
        "SMTP_HOST": "smtp.example.com",
        "SMTP_PORT": "465",
        "SMTP_USER": "u",
        "SMTP_PASSWORD": "p",
        "SMTP_FROM": "LeadHunter <noreply@example.com>",
    }.items():
        monkeypatch.setenv(k, v)
    assert cli_main(["send-test-mail", "me@example.com"]) == 0
    assert fake_smtp.instances[0].sent[0][2] == ["me@example.com"]
    assert "отправлено" in capsys.readouterr().out


def test_cli_send_test_mail_failure(
    fake_smtp: type[FakeSMTP], monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("MAIL_BACKEND", "smtp")
    monkeypatch.setenv("SMTP_HOST", "smtp.example.com")
    fake_smtp.fail_connect = True
    assert cli_main(["send-test-mail", "me@example.com"]) == 1
    assert "Не удалось" in capsys.readouterr().err
