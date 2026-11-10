"""Криптография, время, маскирование, ошибки API."""

from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid
from datetime import UTC, datetime

from app.config import Settings


def now() -> datetime:
    """Текущее время (UTC). Тесты подменяют эту функцию."""
    return datetime.now(UTC)


class AppError(Exception):
    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        *,
        headers: dict[str, str] | None = None,
        extra: dict[str, object] | None = None,
    ) -> None:
        super().__init__(code)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.headers = headers or {}
        self.extra = extra or {}


def generate_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def code_hmac(settings: Settings, challenge_id: uuid.UUID, code: str) -> str:
    msg = f"{challenge_id}{code}".encode()
    return hmac.new(settings.secret_key.encode(), msg, hashlib.sha256).hexdigest()


def verify_code(settings: Settings, challenge_id: uuid.UUID, code: str, expected: str) -> bool:
    actual = code_hmac(settings, challenge_id, code)
    return hmac.compare_digest(actual.encode(), expected.encode())


def keyed_hash(settings: Settings, scope: str, value: str) -> str:
    return hmac.new(settings.secret_key.encode(), f"{scope}:{value}".encode(), "sha256").hexdigest()


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def session_token_hash(settings: Settings, token: str) -> str:
    return keyed_hash(settings, "session", token)


def csrf_for_session(settings: Settings, token: str) -> str:
    """CSRF-токен привязан к сессии (подписанный double-submit)."""
    return keyed_hash(settings, "csrf", token)[:40]


def mask_email(email: str) -> str:
    """a***@d***.ru"""
    local, _, domain = email.partition("@")
    if not domain:
        return "***"
    head, _, tail = domain.partition(".")
    masked_domain = (head[:1] + "***") + (f".{tail}" if tail else "")
    return f"{local[:1]}***@{masked_domain}"
