"""Регистрация по пригласительному коду (закрытая бета). Публичный эндпоинт, поэтому: флаг `registration`, лимит по IP,
одинаковый ответ на «неверный код» и «email уже занят» (не раскрываем существование аккаунтов), код одноразовый и блокируется
на время создания аккаунта. Первый вход: настройка 2FA обязательна (как для всех owner/operator)."""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends, Request
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.auth import client_ip, utcnow
from app.core.permissions import ApiError
from app.core.security import SlidingWindowLimiter, hash_password
from app.db.models import Invite, Membership, Organization, User
from app.db.session import get_db
from app.modules.admin import flags
from app.modules.audit import service as audit
from app.modules.servers.schemas import CamelModel

router = APIRouter(tags=["auth"])
_EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$")
_limiter = SlidingWindowLimiter(10, 3600)
GENERIC = "Не удалось зарегистрироваться. Проверьте код приглашения и данные."


def reset_limiter() -> None:
    global _limiter
    _limiter = SlidingWindowLimiter(10, 3600)


class RegisterIn(CamelModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=200, repr=False)
    invite_code: str = Field(min_length=8, max_length=64)
    name: str = Field(default="", max_length=120)


@router.post("/auth/register", status_code=201)
def register(body: RegisterIn, request: Request, db: Session = Depends(get_db)) -> dict[str, bool]:
    if not flags.is_enabled(db, "registration"):
        raise ApiError(403, "registration_closed", "Регистрация сейчас закрыта.")
    ip = client_ip(request)
    if not _limiter.allow(ip or "unknown"):
        raise ApiError(429, "rate_limited", "Слишком много попыток регистрации. Повторите позже.")
    email = body.email.strip().lower()
    if not _EMAIL.fullmatch(email):
        raise ApiError(422, "validation", "Некорректный email.")
    if len(body.password) < 12 or body.password.lower() == email:
        raise ApiError(422, "validation", "Пароль — не короче 12 символов и не совпадает с email.")
    inv = db.scalar(select(Invite).where(Invite.code == body.invite_code.strip()).with_for_update())
    taken = db.scalar(select(User.id).where(User.email == email)) is not None
    if inv is None or inv.used_at is not None or inv.expires_at <= utcnow() or taken:
        audit.record(db, "register.refused", target=email[:120], ip=ip)  # без причины: не подсказываем, что именно не так
        db.commit()
        raise ApiError(422, "register_failed", GENERIC)
    org = Organization(name="Личное пространство")
    db.add(org)
    db.flush()
    user = User(email=email, name=body.name.strip()[:120], password_hash=hash_password(body.password))
    db.add(user)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise ApiError(422, "register_failed", GENERIC) from None
    db.add(Membership(organization_id=org.id, user_id=user.id, role="owner"))
    inv.used_by, inv.used_at = user.id, utcnow()
    audit.record(db, "user.registered", org_id=org.id, actor_id=user.id, target=email[:120], ip=ip)
    db.commit()
    return {"ok": True}
