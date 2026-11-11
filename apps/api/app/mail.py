"""Отправка писем с кодом входа (SMTP / console для dev)."""

from __future__ import annotations

import hashlib
import hmac
import html
import http.client
import json
import logging
import secrets
import smtplib
import ssl
import time
from email.message import EmailMessage
from email.utils import parseaddr
from typing import Protocol
from urllib.parse import urlsplit

from app.config import Settings
from app.security import mask_email

log = logging.getLogger("leadhunter.mail")

SMTP_TIMEOUT = 15


class MailError(Exception):
    """Сбой отправки (детали не раскрываются клиенту API)."""


class Mailer(Protocol):
    def send(self, to: str, subject: str, text: str, html_body: str) -> None: ...

    def send_otp(self, to: str, code: str, ttl_minutes: int) -> None: ...


def ttl_minutes_for(settings: Settings) -> int:
    """TTL кода в минутах для письма (1..60)."""
    return max(1, min(60, settings.otp_ttl_seconds // 60))


def deliver_otp(mailer: Mailer, to: str, code: str, ttl_minutes: int) -> None:
    """Отправить код входа. Совместимо с «старыми» почтовиками, у которых есть только send()."""
    send_otp = getattr(mailer, "send_otp", None)
    if send_otp is not None:
        send_otp(to, code, ttl_minutes)
        return
    subject, text, html_body = render_otp_email(code, ttl_minutes)
    mailer.send(to, subject, text, html_body)


def render_otp_email(code: str, ttl_minutes: int = 10) -> tuple[str, str, str]:
    """Возвращает (тема, text, html)."""
    subject = f"Код входа LeadHunter: {code}"
    footer = (
        f"Код действует {ttl_minutes} минут. "
        "Если вы не запрашивали вход — просто проигнорируйте письмо."
    )
    text = f"LeadHunter\n\nВаш код для входа: {code}\n\n{footer}\n"
    spaced = "&nbsp;".join(html.escape(code))
    foot = html.escape(footer)
    sans = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
    mono = "'SF Mono',Menlo,Consolas,'Courier New',monospace"
    body = f"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>{html.escape(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f6f7f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f7f5;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#ffffff;border-radius:16px;border:1px solid #e3e8e5;">
<tr><td style="padding:32px 32px 8px 32px;font-family:{sans};">
<div style="font-size:15px;font-weight:700;letter-spacing:.02em;color:#116c57;">LeadHunter</div>
<h1 style="margin:20px 0 8px 0;font-size:22px;line-height:1.3;font-weight:700;color:#1b2927;">Код для входа</h1>
<p style="margin:0;font-size:15px;line-height:1.5;color:#1b2927;">Введите этот код на странице входа:</p>
</td></tr>
<tr><td align="center" style="padding:20px 32px;">
<div style="font-family:{mono};font-size:36px;line-height:1.2;font-weight:700;letter-spacing:.18em;color:#116c57;background:#f6f7f5;border-radius:12px;padding:18px 12px;">{spaced}</div>
</td></tr>
<tr><td style="padding:0 32px 32px 32px;font-family:{sans};">
<p style="margin:0;font-size:13px;line-height:1.5;color:#1b2927;">{foot}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
"""
    return subject, text, body


def build_message(
    settings: Settings, to: str, subject: str, text: str, html_body: str
) -> EmailMessage:
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = settings.smtp_from
    msg["To"] = to
    msg["Auto-Submitted"] = "auto-generated"
    msg.set_content(text)
    msg.add_alternative(html_body, subtype="html")
    return msg


class SmtpMailer:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def send_otp(self, to: str, code: str, ttl_minutes: int) -> None:
        subject, text, html_body = render_otp_email(code, ttl_minutes)
        self.send(to, subject, text, html_body)

    def send(self, to: str, subject: str, text: str, html_body: str) -> None:
        s = self.settings
        msg = build_message(s, to, subject, text, html_body)
        envelope_from = parseaddr(s.smtp_from)[1] or s.smtp_user
        try:
            security = s.smtp_security_effective
            client: smtplib.SMTP
            if security == "ssl":
                client = smtplib.SMTP_SSL(
                    s.smtp_host,
                    s.smtp_port,
                    timeout=SMTP_TIMEOUT,
                    context=ssl.create_default_context(),
                )
            else:
                client = smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=SMTP_TIMEOUT)
            with client:
                if security == "starttls":
                    client.starttls(context=ssl.create_default_context())
                if s.smtp_user:
                    client.login(s.smtp_user, s.smtp_password)
                client.send_message(msg, from_addr=envelope_from, to_addrs=[to])
        except (OSError, smtplib.SMTPException) as exc:
            # Только тип ошибки: текст может содержать адреса/детали сервера.
            log.error("SMTP: отправка на %s не удалась (%s)", mask_email(to), type(exc).__name__)
            raise MailError(type(exc).__name__) from exc


class ConsoleMailer:
    """Только dev: печатает код (из текста письма) в лог."""

    def __init__(self, settings: Settings) -> None:
        if settings.env != "dev":
            raise RuntimeError("MAIL_BACKEND=console разрешён только при ENV=dev")

    def send_otp(self, to: str, code: str, ttl_minutes: int) -> None:
        subject, text, html_body = render_otp_email(code, ttl_minutes)
        self.send(to, subject, text, html_body)

    def send(self, to: str, subject: str, text: str, html_body: str) -> None:
        log.warning("[mail:console] to=%s subject=%s", mask_email(to), subject)


RELAY_TIMEOUT = 15
RELAY_MAX_RESPONSE = 4096


def sign_relay_request(secret: str, timestamp: str, nonce: str, body: bytes) -> str:
    """hex HMAC-SHA256(secret, timestamp + "." + nonce + "." + body) — схема infra/mail-relay."""
    msg = timestamp.encode() + b"." + nonce.encode() + b"." + body
    return hmac.new(secret.encode(), msg, hashlib.sha256).hexdigest()


class HttpRelayMailer:
    """Отправка через HTTPS-ретранслятор (PHP на хостинге). Шлёт только {to, code, ttl_minutes}."""

    def __init__(self, settings: Settings) -> None:
        self._url = settings.mail_relay_url
        self._secret = settings.mail_relay_secret

    def __repr__(self) -> str:
        return "HttpRelayMailer(url=<hidden>)"

    def send(self, to: str, subject: str, text: str, html_body: str) -> None:
        raise MailError("HttpRelayMailer отправляет только коды входа (send_otp)")

    def send_otp(self, to: str, code: str, ttl_minutes: int) -> None:
        body = json.dumps(
            {"to": to, "code": code, "ttl_minutes": ttl_minutes},
            separators=(",", ":"),
            ensure_ascii=True,
        ).encode()
        ts = str(int(time.time()))
        nonce = secrets.token_urlsafe(24)
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Content-Length": str(len(body)),
            "X-LH-Timestamp": ts,
            "X-LH-Nonce": nonce,
            "X-LH-Signature": sign_relay_request(self._secret, ts, nonce, body),
        }
        parts = urlsplit(self._url)
        path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
        conn: http.client.HTTPConnection
        try:
            if parts.scheme == "https":
                conn = http.client.HTTPSConnection(
                    parts.hostname or "",
                    parts.port,
                    timeout=RELAY_TIMEOUT,
                    context=ssl.create_default_context(),
                )
            else:
                conn = http.client.HTTPConnection(
                    parts.hostname or "", parts.port, timeout=RELAY_TIMEOUT
                )
            try:
                conn.request("POST", path, body=body, headers=headers)
                resp = conn.getresponse()
                status = resp.status  # редиректы не выполняются: 3xx = ошибка
                raw = resp.read(RELAY_MAX_RESPONSE)
            finally:
                conn.close()
        except (OSError, http.client.HTTPException) as exc:
            log.error(
                "Ретранслятор: запрос на %s не удался (%s)", mask_email(to), type(exc).__name__
            )
            raise MailError(type(exc).__name__) from exc
        ok = False
        reason = f"HTTP {status}"
        try:
            data = json.loads(raw)
            if isinstance(data, dict):
                ok = status == 200 and data.get("ok") is True
                err = data.get("code")
                if isinstance(err, str) and err.isidentifier():
                    reason = f"HTTP {status} {err}"
        except ValueError:
            reason = f"HTTP {status} (не JSON)"
        if not ok:
            log.error("Ретранслятор: отказ для %s (%s)", mask_email(to), reason)
            raise MailError(reason)


def make_mailer(settings: Settings) -> Mailer:
    if settings.mail_backend == "smtp":
        return SmtpMailer(settings)
    if settings.mail_backend == "http":
        return HttpRelayMailer(settings)
    return ConsoleMailer(settings)
