"""Дашборд: агрегаты только из БД (никаких выдуманных чисел)."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.company_schemas import DashboardOut
from app.config import Settings
from app.db import get_db
from app.deps import get_settings, require_active_user
from app.models import User
from app.services import companies as svc

router = APIRouter(prefix="/api/v1", tags=["dashboard"])


@router.get("/dashboard", response_model=DashboardOut)
def get_dashboard(
    _user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> DashboardOut:
    return svc.dashboard(db, settings.score_threshold)
