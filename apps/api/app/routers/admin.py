"""Администрирование пользователей (только owner)."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app import security
from app.db import get_db
from app.deps import require_owner, require_owner_csrf
from app.models import AuditLog, SessionRow, User
from app.schemas import AdminUserOut, AdminUserResult, UsersOut
from app.security import AppError

router = APIRouter(prefix="/api/v1/admin", tags=["admin"])


def _out(u: User) -> AdminUserOut:
    return AdminUserOut(
        id=u.id,
        email=u.email,
        role=u.role,
        status=u.status,
        created_at=u.created_at.isoformat(),
        last_login_at=u.last_login_at.isoformat() if u.last_login_at else None,
    )


def _get_user(db: Session, user_id: uuid.UUID) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise AppError(404, "NOT_FOUND", "Пользователь не найден.")
    return user


@router.get("/users", response_model=UsersOut)
def list_users(_owner: User = Depends(require_owner), db: Session = Depends(get_db)) -> UsersOut:
    users = db.scalars(select(User).order_by(User.created_at, User.email)).all()
    return UsersOut(users=[_out(u) for u in users])


@router.post("/users/{user_id}/approve", response_model=AdminUserResult)
def approve_user(
    user_id: uuid.UUID,
    owner: User = Depends(require_owner_csrf),
    db: Session = Depends(get_db),
) -> AdminUserResult:
    user = _get_user(db, user_id)
    user.status = "active"
    db.add(
        AuditLog(actor_id=owner.id, action="admin.approve", entity="user", entity_id=str(user.id))
    )
    db.commit()
    return AdminUserResult(user=_out(user))


@router.post("/users/{user_id}/block", response_model=AdminUserResult)
def block_user(
    user_id: uuid.UUID,
    owner: User = Depends(require_owner_csrf),
    db: Session = Depends(get_db),
) -> AdminUserResult:
    user = _get_user(db, user_id)
    if user.id == owner.id:
        raise AppError(400, "CANNOT_BLOCK_SELF", "Нельзя заблокировать самого себя.")
    if user.role == "owner" and user.status == "active":
        owners = db.scalar(
            select(func.count())
            .select_from(User)
            .where(User.role == "owner", User.status == "active")
        )
        if (owners or 0) <= 1:
            raise AppError(409, "LAST_OWNER", "Нельзя заблокировать последнего владельца.")
    user.status = "blocked"
    db.execute(
        update(SessionRow)
        .where(SessionRow.user_id == user.id, SessionRow.revoked_at.is_(None))
        .values(revoked_at=security.now())
    )
    db.add(AuditLog(actor_id=owner.id, action="admin.block", entity="user", entity_id=str(user.id)))
    db.commit()
    return AdminUserResult(user=_out(user))
