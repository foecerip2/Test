"""Отправка писем с кодом входа (SMTP / console для dev)."""

from __future__ import annotations

import html
import logging
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import parseaddr
from typing import Protocol

from app.config import Settings
from app.security import mask_email

log = logging.getLogger("leadhunter.mail")

SMTP_TIMEOUT = 15


class MailError(Exception):
    """Сбой отправки (детали не раскрываются клиенту API)."""


class Mailer(Protocol):
    def send(self, to: str, subject: str, text: str, html_body: str) -> None: ...


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

    def send(self, to: str, subject: str, text: str, html_body: str) -> None:
        log.warning("[mail:console] to=%s subject=%s", mask_email(to), subject)


def make_mailer(settings: Settings) -> Mailer:
    if settings.mail_backend == "smtp":
        return SmtpMailer(settings)
    return ConsoleMailer(settings)
