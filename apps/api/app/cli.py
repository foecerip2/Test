"""CLI: python -m app.cli send-test-mail you@example.com"""

from __future__ import annotations

import argparse
import secrets
import sys

from pydantic import ValidationError

from app.config import Settings
from app.mail import MailError, deliver_otp, make_mailer, ttl_minutes_for


def send_test_mail(to: str) -> int:
    try:
        settings = Settings()
    except ValidationError as exc:
        print(f"Ошибка конфигурации: {exc}", file=sys.stderr)
        return 2
    mailer = make_mailer(settings)
    # Тестовое письмо — это тоже «код входа» (ретранслятор принимает только такие письма).
    code = f"{secrets.randbelow(10**6):06d}"
    try:
        deliver_otp(mailer, to, code, ttl_minutes_for(settings))
    except MailError as exc:
        cause = exc.__cause__
        print(
            f"Не удалось отправить письмо: {type(cause).__name__ if cause else exc}: {cause}",
            file=sys.stderr,
        )
        return 1
    if settings.mail_backend == "http":
        print("Тестовый код отправлен (через HTTPS-ретранслятор). Проверьте ящик и папку «Спам».")
    else:
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
