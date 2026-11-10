"""Роли и доступ к tenant-ресурсам. Чужой ресурс неотличим от несуществующего (404) — не раскрываем факт существования."""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import Server

if TYPE_CHECKING:
    from app.core.auth import AuthContext

ROLE_RANK = {"viewer": 1, "operator": 2, "owner": 3}


class ApiError(HTTPException):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(status_code=status, detail=message)
        self.code = code
        self.message = message


def require_role(ctx: AuthContext, minimum: str) -> None:
    if ROLE_RANK.get(ctx.role, 0) < ROLE_RANK[minimum]:
        raise ApiError(403, "forbidden", "Недостаточно прав для этого действия.")


def get_server_or_404(db: Session, ctx: AuthContext, server_id: str) -> Server:
    try:
        sid = uuid.UUID(server_id)
    except ValueError:
        raise ApiError(404, "not_found", "Сервер не найден или нет доступа.") from None
    # organization_id берётся ТОЛЬКО из сессии, никогда из запроса
    server = db.scalar(select(Server).where(Server.id == sid, Server.organization_id == ctx.org_id))
    if server is None:
        raise ApiError(404, "not_found", "Сервер не найден или нет доступа.")
    return server
