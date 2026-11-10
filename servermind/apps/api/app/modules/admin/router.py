"""Админ-панель платформы закрытой беты: флаги, kill switch, приглашения, пользователи. Только администратор платформы
(PLATFORM_ADMIN_EMAILS, сессия с 2FA); для остальных 404. Все изменения аудируются."""

from __future__ import annotations

import datetime as dt
import secrets
import uuid
from typing import Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.auth import AuthContext, client_ip, utcnow
from app.core.config import get_settings
from app.core.permissions import ApiError
from app.db.models import Invite, Membership, User, UserSession
from app.db.session import get_db
from app.modules.admin import flags
from app.modules.audit import service as audit
from app.modules.billing.router import require_platform_admin

router = APIRouter(prefix="/admin", tags=["admin"])
INVITE_TTL = dt.timedelta(days=7)


def _iso(t: Any) -> str | None:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ") if t else None


class EnabledIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool


class KillIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    executionEnabled: bool  # noqa: N815 — имя поля совпадает с контрактом интерфейса


class ActiveIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    active: bool


# ───────── флаги ─────────
def _flag_list(db: Session) -> list[dict[str, Any]]:
    return [{"key": k, "label": v[0], "description": v[1], "enabled": flags.is_enabled(db, k)} for k, v in flags.FLAGS.items()]


@router.get("/flags")
def list_flags(_: AuthContext = Depends(require_platform_admin), db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    return _flag_list(db)


@router.put("/flags/{key}")
def set_flag(key: str, body: EnabledIn, request: Request, ctx: AuthContext = Depends(require_platform_admin), db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    if key not in flags.FLAGS:
        raise ApiError(404, "not_found", "Флаг не найден.")
    flags.set_value(db, key, body.enabled, ctx.user.id)
    audit.record(db, "flag.set", actor_id=ctx.user.id, target=key, meta={"enabled": body.enabled}, ip=client_ip(request))
    db.commit()
    return _flag_list(db)


# ───────── kill switch ─────────
def _kill_out(db: Session) -> dict[str, Any]:
    s = get_settings()
    return {"executionEnabled": flags.execution_allowed(db, s), "configAllows": bool(s.execution_enabled), "engaged": flags.kill_engaged(db)}


@router.get("/kill-switch")
def get_kill(_: AuthContext = Depends(require_platform_admin), db: Session = Depends(get_db)) -> dict[str, Any]:
    return _kill_out(db)


@router.put("/kill-switch")
def put_kill(body: KillIn, request: Request, ctx: AuthContext = Depends(require_platform_admin), db: Session = Depends(get_db)) -> dict[str, Any]:
    if body.executionEnabled and not get_settings().execution_enabled:
        raise ApiError(409, "execution_disabled_by_config", "Исполнение выключено конфигурацией сервера (EXECUTION_ENABLED=false): включить его из админки нельзя.")
    flags.set_value(db, flags.KILL, not body.executionEnabled, ctx.user.id)
    audit.record(db, "kill_switch.set", actor_id=ctx.user.id, target="execution", meta={"execution_enabled": body.executionEnabled}, ip=client_ip(request))
    db.commit()
    return _kill_out(db)


# ───────── приглашения ─────────
def _invite_out(db: Session, i: Invite) -> dict[str, Any]:
    used_by = db.get(User, i.used_by).email if i.used_by and db.get(User, i.used_by) else None
    return {"code": i.code, "createdAt": _iso(i.created_at), "expiresAt": _iso(i.expires_at), "usedBy": used_by}


@router.get("/invites")
def list_invites(_: AuthContext = Depends(require_platform_admin), db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    rows = db.scalars(select(Invite).order_by(Invite.created_at.desc()).limit(100)).all()
    return [_invite_out(db, i) for i in rows]


@router.post("/invites", status_code=201)
def create_invite(request: Request, ctx: AuthContext = Depends(require_platform_admin), db: Session = Depends(get_db)) -> dict[str, Any]:
    inv = Invite(code=secrets.token_urlsafe(18), created_by=ctx.user.id, expires_at=utcnow() + INVITE_TTL)
    db.add(inv)
    db.flush()
    audit.record(db, "invite.create", actor_id=ctx.user.id, target=str(inv.id), ip=client_ip(request))  # сам код в аудит не пишется
    db.commit()
    return _invite_out(db, inv)


# ───────── пользователи ─────────
@router.get("/users")
def list_users(_: AuthContext = Depends(require_platform_admin), db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    rows = db.scalars(select(User).order_by(User.created_at.desc()).limit(200)).all()
    out = []
    for u in rows:
        role = db.scalar(select(Membership.role).where(Membership.user_id == u.id).limit(1))
        out.append({"id": str(u.id), "email": u.email, "name": u.name, "role": role or "—", "active": u.is_active, "createdAt": _iso(u.created_at)})
    return out


@router.post("/users/{user_id}/active")
def set_user_active(user_id: str, body: ActiveIn, request: Request, ctx: AuthContext = Depends(require_platform_admin),
                    db: Session = Depends(get_db)) -> dict[str, Any]:
    try:
        uid = uuid.UUID(user_id)
    except ValueError:
        raise ApiError(404, "not_found", "Пользователь не найден.") from None
    user = db.get(User, uid, with_for_update=True)
    if user is None:
        raise ApiError(404, "not_found", "Пользователь не найден.")
    if user.id == ctx.user.id and not body.active:
        raise ApiError(409, "self_disable", "Нельзя отключить самого себя.")
    user.is_active = body.active
    if not body.active:
        db.execute(delete(UserSession).where(UserSession.user_id == user.id))  # все сессии закрываются немедленно
    audit.record(db, "user.active_set", actor_id=ctx.user.id, target=user.email, meta={"active": body.active}, ip=client_ip(request))
    db.commit()
    return {"id": str(user.id), "email": user.email, "active": user.is_active}
