"""Зависимости FastAPI: настройки, сессия, роли, CSRF."""

from __future__ import annotations

import hmac
from dataclasses import dataclass

from fastapi import Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import security
from app.config import Settings
from app.db import get_db
from app.mail import Mailer
from app.models import SessionRow, User

SESSION_COOKIE = "lh_session"
CSRF_COOKIE = "lh_csrf"
CSRF_HEADER = "X-CSRF-Token"


def get_settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def get_mailer(request: Request) -> Mailer:
    mailer: Mailer = request.app.state.mailer
    return mailer


def client_ip(request: Request, settings: Settings) -> str:
    if settings.trust_proxy_effective:
        xff = request.headers.get("x-forwarded-for", "")
        parts = [p.strip() for p in xff.split(",") if p.strip()]
        if parts:
            return parts[-1]  # последняя запись добавлена нашим reverse proxy
    return request.client.host if request.client else "unknown"


@dataclass
class AuthContext:
    session: SessionRow
    user: User
    token: str


def get_auth(
    request: Request,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> AuthContext:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise security.AppError(401, "UNAUTHENTICATED", "Требуется вход.")
    row = db.scalar(
        select(SessionRow).where(
            SessionRow.token_hash == security.session_token_hash(settings, token)
        )
    )
    if row is None or row.revoked_at is not None or row.expires_at <= security.now():
        raise security.AppError(401, "UNAUTHENTICATED", "Сессия недействительна. Войдите снова.")
    user = db.get(User, row.user_id)
    if user is None or user.status == "blocked":
        raise security.AppError(401, "UNAUTHENTICATED", "Сессия недействительна. Войдите снова.")
    return AuthContext(session=row, user=user, token=token)


def get_current_user(auth: AuthContext = Depends(get_auth)) -> User:
    return auth.user


def require_active_user(auth: AuthContext = Depends(get_auth)) -> User:
    if auth.user.status != "active":
        raise security.AppError(403, "ACCOUNT_PENDING", "Аккаунт ожидает одобрения владельца.")
    return auth.user


def require_owner(user: User = Depends(require_active_user)) -> User:
    if user.role != "owner":
        raise security.AppError(403, "FORBIDDEN", "Недостаточно прав.")
    return user


def require_csrf(
    request: Request,
    auth: AuthContext = Depends(get_auth),
    settings: Settings = Depends(get_settings),
) -> AuthContext:
    header = request.headers.get(CSRF_HEADER, "")
    cookie = request.cookies.get(CSRF_COOKIE, "")
    expected = security.csrf_for_session(settings, auth.token)
    ok = (
        bool(header)
        and hmac.compare_digest(header.encode(), cookie.encode())
        and hmac.compare_digest(header.encode(), expected.encode())
    )
    if not ok:
        raise security.AppError(403, "CSRF_FAILED", "Проверка CSRF не пройдена. Обновите страницу.")
    return auth


def require_owner_csrf(
    user: User = Depends(require_owner), _csrf: AuthContext = Depends(require_csrf)
) -> User:
    return user
