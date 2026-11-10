"""Liveness / readiness."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import require_active_user
from app.models import User
from app.security import AppError

router = APIRouter()


@router.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/readyz")
def readyz(db: Session = Depends(get_db)) -> dict[str, str]:
    try:
        db.execute(text("SELECT 1"))
    except Exception as exc:
        raise AppError(503, "NOT_READY", "Сервис не готов.") from exc
    return {"status": "ok"}


@router.get("/api/v1/ping")
def ping(user: User = Depends(require_active_user)) -> dict[str, str]:
    """Тестовый защищённый эндпоинт: требует status=active."""
    return {"status": "ok", "user_id": str(user.id)}
