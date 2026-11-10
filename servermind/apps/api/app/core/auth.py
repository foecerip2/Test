"""Cookie-сессии: непрозрачный токен (в БД только SHA-256), CSRF-токен в заголовке, idle/absolute-таймауты, стадии 2FA."""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Callable
from dataclasses import dataclass

from fastapi import Depends, Request, Response
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.permissions import ApiError
from app.core.security import consteq, hash_token, new_token
from app.db.models import Membership, Organization, User, UserSession
from app.db.session import get_db

COOKIE = "sm_session"
CSRF_HEADER = "x-csrf-token"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


@dataclass
class AuthContext:
    user: User
    org_id: uuid.UUID
    org_name: str
    role: str
    session: UserSession


def client_ip(request: Request) -> str:
    # За reverse-proxy (Caddy) нужен доверенный X-Forwarded-For — настройка появится в Фазе 4. Сейчас — прямой адрес.
    return request.client.host if request.client else ""


def create_session(db: Session, user: User, stage: str, request: Request) -> tuple[str, UserSession]:
    s = get_settings()
    token = new_token()
    now = utcnow()
    row = UserSession(
        user_id=user.id, token_hash=hash_token(token), csrf_token=new_token(), stage=stage,
        ip=client_ip(request), user_agent=(request.headers.get("user-agent") or "")[:255],
        created_at=now, last_seen_at=now, expires_at=now + dt.timedelta(days=s.session_absolute_days),
    )
    db.add(row)
    db.flush()
    return token, row


def set_session_cookie(response: Response, token: str) -> None:
    s = get_settings()
    response.set_cookie(
        COOKIE, token, httponly=True, secure=s.cookie_secure, samesite="lax", path="/",
        max_age=s.session_absolute_days * 86400,
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(COOKIE, path="/")


def rotate_session(db: Session, old: UserSession, user: User, stage: str, request: Request, response: Response) -> UserSession:
    """Новый токен при смене привилегий (защита от session fixation)."""
    db.execute(delete(UserSession).where(UserSession.id == old.id))
    token, row = create_session(db, user, stage, request)
    set_session_cookie(response, token)
    return row


def get_ctx(*stages: str) -> Callable[..., AuthContext]:
    allowed = stages or ("active",)

    def dep(request: Request, db: Session = Depends(get_db)) -> AuthContext:
        s = get_settings()
        token = request.cookies.get(COOKIE)
        if not token:
            raise ApiError(401, "unauthorized", "Требуется вход.")
        row = db.scalar(select(UserSession).where(UserSession.token_hash == hash_token(token)))
        now = utcnow()
        if row is None:
            raise ApiError(401, "unauthorized", "Сессия недействительна. Войдите заново.")
        idle = dt.timedelta(minutes=s.session_idle_minutes)
        if row.expires_at <= now or row.last_seen_at + idle <= now:
            db.delete(row)
            db.commit()
            raise ApiError(401, "session_expired", "Сессия истекла. Войдите заново.")
        if request.method not in SAFE_METHODS:
            sent = request.headers.get(CSRF_HEADER, "")
            if not sent or not consteq(sent, row.csrf_token):
                raise ApiError(403, "csrf", "Не пройдена проверка CSRF.")
        user = db.get(User, row.user_id)
        if user is None or not user.is_active:
            raise ApiError(401, "unauthorized", "Учётная запись отключена.")
        if row.stage not in allowed:
            if row.stage == "pending_2fa":
                raise ApiError(403, "two_factor_required", "Введите код двухфакторной аутентификации.")
            if row.stage == "needs_2fa_setup":
                raise ApiError(403, "two_factor_setup_required", "Для вашей роли обязательна двухфакторная аутентификация.")
            raise ApiError(403, "forbidden", "Действие недоступно на этом этапе входа.")
        m = db.execute(
            select(Membership, Organization).join(Organization, Organization.id == Membership.organization_id)
            .where(Membership.user_id == user.id).order_by(Membership.created_at).limit(1)
        ).first()
        if m is None:
            raise ApiError(403, "forbidden", "Нет рабочего пространства.")
        if (now - row.last_seen_at).total_seconds() > 60:
            row.last_seen_at = now
            db.commit()
        return AuthContext(user=user, org_id=m[0].organization_id, org_name=m[1].name, role=m[0].role, session=row)

    return dep
