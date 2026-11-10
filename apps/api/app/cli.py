"""CLI: python -m app.cli send-test-mail you@example.com"""

from __future__ import annotations

import argparse
import sys

from pydantic import ValidationError

from app.config import Settings
from app.mail import MailError, make_mailer, render_otp_email


def send_test_mail(to: str) -> int:
    try:
        settings = Settings()
    except ValidationError as exc:
        print(f"Ошибка конфигурации: {exc}", file=sys.stderr)
        return 2
    mailer = make_mailer(settings)
    subject, text, html_body = render_otp_email("123456", settings.otp_ttl_seconds // 60)
    try:
        mailer.send(to, subject, text, html_body)
    except MailError as exc:
        cause = exc.__cause__
        print(
            f"Не удалось отправить письмо: {type(cause).__name__ if cause else exc}: {cause}",
            file=sys.stderr,
        )
        return 1
    print(f"Тестовое письмо отправлено (backend={settings.mail_backend}).")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("send-test-mail", help="Проверить SMTP: отправить тестовое письмо")
    p.add_argument("to", help="адрес получателя")
    args = parser.parse_args(argv)
    if args.command == "send-test-mail":
        return send_test_mail(args.to)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
