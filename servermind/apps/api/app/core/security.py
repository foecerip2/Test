"""Криптографические примитивы: пароли (argon2id), AEAD (AES-256-GCM), токены, TOTP, редактирование секретов."""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import time
from collections import defaultdict, deque

import pyotp
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_ph = PasswordHasher()
# Хеш для несуществующего пользователя: выравнивает время ответа (защита от перебора email по таймингу).
DUMMY_HASH = _ph.hash("servermind-dummy-password")


def hash_password(password: str) -> str:
    return _ph.hash(password)


def verify_password(hashed: str, password: str) -> bool:
    try:
        return _ph.verify(hashed, password)
    except (VerificationError, InvalidHashError):
        return False


def new_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    """В БД хранится только SHA-256 токена сессии: утечка таблицы не даёт войти."""
    return hashlib.sha256(token.encode()).hexdigest()


def consteq(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())


# ───────── AEAD ─────────
class DecryptionError(Exception):
    pass


_VERSION = b"\x01"


def encrypt(master_key: bytes, plaintext: bytes, aad: bytes) -> bytes:
    """AES-256-GCM, случайный 96-бит nonce, привязка к контексту через AAD. Формат: v1 | nonce | ciphertext+tag."""
    nonce = secrets.token_bytes(12)
    return _VERSION + nonce + AESGCM(master_key).encrypt(nonce, plaintext, aad)


def decrypt(master_key: bytes, blob: bytes, aad: bytes) -> bytes:
    if len(blob) < 1 + 12 + 16 or blob[:1] != _VERSION:
        raise DecryptionError("неверный формат")
    try:
        return AESGCM(master_key).decrypt(blob[1:13], blob[13:], aad)
    except InvalidTag as e:
        raise DecryptionError("не удалось расшифровать (неверный ключ, контекст или данные изменены)") from e


# ───────── TOTP ─────────
def new_totp_secret() -> str:
    return pyotp.random_base32()


def totp_uri(secret: str, email: str, issuer: str = "ServerMind") -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name=issuer)


def verify_totp(secret: str, code: str, last_step: int, now: float | None = None) -> int | None:
    """Возвращает номер использованного 30-секундного шага или None. Повторное использование шага запрещено (replay)."""
    if not re.fullmatch(r"\d{6}", code or ""):
        return None
    t = time.time() if now is None else now
    totp = pyotp.TOTP(secret)
    base = int(t // 30)
    for step in (base - 1, base, base + 1):
        if step > last_step and hmac.compare_digest(totp.at(step * 30), code):
            return step
    return None


# ───────── redaction ─────────
_PATTERNS = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S),
    re.compile(r"\b(sk|pk|rk)-[A-Za-z0-9_\-]{12,}"),
    re.compile(r"(?i)\b(password|passwd|secret|token|api[_-]?key)\b\s*[=:]\s*\S+"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._\-]{12,}"),
]


def redact(text: str) -> str:
    for p in _PATTERNS:
        text = p.sub("[REDACTED]", text)
    return text


# ───────── rate limit (в памяти процесса) ─────────
class SlidingWindowLimiter:
    def __init__(self, limit: int, window_seconds: float) -> None:
        self.limit, self.window = limit, window_seconds
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def allow(self, key: str, now: float | None = None) -> bool:
        t = time.monotonic() if now is None else now
        q = self._hits[key]
        while q and q[0] <= t - self.window:
            q.popleft()
        if len(q) >= self.limit:
            return False
        q.append(t)
        return True

    def reset(self) -> None:
        self._hits.clear()
