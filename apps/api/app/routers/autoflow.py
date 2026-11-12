"""Закрытое приложение AutoFlow: регистрация, настройки, услуги и расписание."""

from __future__ import annotations

import uuid
from datetime import date
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import security
from app.autoflow_models import Appointment, AutoFlowAccount, Resource, Service, Workspace
from app.autoflow_schemas import (
    AccountIn,
    AppointmentIn,
    AppointmentPatch,
    ResourceIn,
    ServiceIn,
    WorkspaceIn,
)
from app.db import get_db
from app.deps import AuthContext, get_auth, require_csrf, require_owner, require_owner_csrf
from app.models import AuditLog, User
from app.pilot_schemas import PilotRequestPatch
from app.security import AppError

router = APIRouter(prefix="/api/v1/autoflow", tags=["autoflow-app"])


def out(row: Any) -> dict[str, Any]:
    return {
        column.name: getattr(row, column.name)
        for column in row.__table__.columns
        if column.name not in {"owner_id", "workspace_id", "user_id"}
    }


def workspace(db: Session, user: User) -> Workspace:
    row = db.scalar(select(Workspace).where(Workspace.owner_id == user.id))
    if row is None:
        raise AppError(409, "SETUP_REQUIRED", "Сначала настройте автосервис.")
    return row


def audit(db: Session, user: User, action: str, entity_id: uuid.UUID) -> None:
    db.add(
        AuditLog(
            actor_id=user.id,
            action=f"autoflow.{action}",
            entity="autoflow",
            entity_id=str(entity_id),
        )
    )


@router.get("/account")
def account(auth: AuthContext = Depends(get_auth), db: Session = Depends(get_db)) -> dict[str, Any]:
    profile = db.get(AutoFlowAccount, auth.user.id)
    return {
        "user": {"id": str(auth.user.id), "email": auth.user.email},
        "profile": out(profile) if profile else None,
        "access": "admin"
        if auth.user.role == "owner" and auth.user.status == "active"
        else "waiting",
    }


@router.put("/account")
def register(
    body: AccountIn, auth: AuthContext = Depends(require_csrf), db: Session = Depends(get_db)
) -> dict[str, Any]:
    row = db.get(AutoFlowAccount, auth.user.id)
    if row is None:
        row = AutoFlowAccount(user_id=auth.user.id, consent_at=security.now())
        db.add(row)
    row.name, row.business_name, row.city = body.name, body.business_name, body.city
    audit(db, auth.user, "account.saved", auth.user.id)
    db.commit()
    return account(auth, db)


@router.get("/app/state")
def state(
    day: date, user: User = Depends(require_owner), db: Session = Depends(get_db)
) -> dict[str, Any]:
    w = db.scalar(select(Workspace).where(Workspace.owner_id == user.id))
    if w is None:
        return {"workspace": None, "services": [], "resources": [], "appointments": []}
    return {
        "workspace": out(w),
        "services": [
            out(r)
            for r in db.scalars(
                select(Service).where(Service.workspace_id == w.id).order_by(Service.name)
            )
        ],
        "resources": [
            out(r)
            for r in db.scalars(
                select(Resource).where(Resource.workspace_id == w.id).order_by(Resource.name)
            )
        ],
        "appointments": [
            out(r)
            for r in db.scalars(
                select(Appointment)
                .where(Appointment.workspace_id == w.id, Appointment.day == day)
                .order_by(Appointment.starts)
            )
        ],
    }


@router.put("/app/workspace")
def save_workspace(
    body: WorkspaceIn, user: User = Depends(require_owner_csrf), db: Session = Depends(get_db)
) -> dict[str, Any]:
    # Сериализуем создание контура одним владельцем, включая два одновременно открытых окна.
    db.scalar(select(User).where(User.id == user.id).with_for_update())
    w = db.scalar(select(Workspace).where(Workspace.owner_id == user.id))
    if w is None:
        w = Workspace(owner_id=user.id)
        db.add(w)
    for key, value in body.model_dump().items():
        setattr(w, key, value)
    db.flush()
    audit(db, user, "workspace.saved", w.id)
    db.commit()
    return out(w)


@router.post("/app/services", status_code=201)
def create_service(
    body: ServiceIn, user: User = Depends(require_owner_csrf), db: Session = Depends(get_db)
) -> dict[str, Any]:
    w = workspace(db, user)
    row = Service(workspace_id=w.id, **body.model_dump())
    db.add(row)
    db.flush()
    audit(db, user, "service.created", row.id)
    db.commit()
    return out(row)


@router.post("/app/resources", status_code=201)
def create_resource(
    body: ResourceIn, user: User = Depends(require_owner_csrf), db: Session = Depends(get_db)
) -> dict[str, Any]:
    w = workspace(db, user)
    row = Resource(workspace_id=w.id, **body.model_dump())
    db.add(row)
    db.flush()
    audit(db, user, "resource.created", row.id)
    db.commit()
    return out(row)


def resource_lock(db: Session, workspace_id: uuid.UUID, resource_id: uuid.UUID) -> Resource:
    row = db.scalar(
        select(Resource)
        .where(Resource.id == resource_id, Resource.workspace_id == workspace_id)
        .with_for_update()
    )
    if row is None:
        raise AppError(404, "NOT_FOUND", "Бокс не найден.")
    return row


def available(db: Session, row: Appointment) -> None:
    conflict = db.scalar(
        select(Appointment.id)
        .where(
            Appointment.resource_id == row.resource_id,
            Appointment.day == row.day,
            Appointment.id != row.id,
            Appointment.status != "cancelled",
            Appointment.starts < row.ends,
            Appointment.ends > row.starts,
        )
        .limit(1)
    )
    if conflict is not None:
        raise AppError(409, "SLOT_TAKEN", "Это время уже занято. Выберите другое время или бокс.")


@router.post("/app/appointments", status_code=201)
def create_appointment(
    body: AppointmentIn, user: User = Depends(require_owner_csrf), db: Session = Depends(get_db)
) -> dict[str, Any]:
    w = workspace(db, user)
    resource_lock(db, w.id, body.resource_id)
    service = db.scalar(
        select(Service).where(Service.id == body.service_id, Service.workspace_id == w.id)
    )
    if service is None:
        raise AppError(404, "NOT_FOUND", "Услуга не найдена.")
    local_now = security.now().astimezone(ZoneInfo("Europe/Moscow"))
    ends = body.starts + service.duration
    if body.day < local_now.date() or (
        body.day == local_now.date() and body.starts < local_now.hour * 60 + local_now.minute
    ):
        raise AppError(422, "PAST_APPOINTMENT", "Нельзя создать запись в прошлом.")
    if body.starts % 15 or body.starts < w.opens or ends > w.closes:
        raise AppError(
            422, "OUTSIDE_HOURS", "Запись должна помещаться в рабочие часы с шагом 15 минут."
        )
    row = Appointment(
        id=uuid.uuid4(),
        workspace_id=w.id,
        ends=ends,
        status="new",
        consent_at=security.now(),
        **body.model_dump(exclude={"consent"}),
    )
    available(db, row)
    db.add(row)
    audit(db, user, "appointment.created", row.id)
    db.commit()
    return out(row)


@router.patch("/app/appointments/{appointment_id}")
def update_appointment(
    appointment_id: uuid.UUID,
    body: AppointmentPatch,
    user: User = Depends(require_owner_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    w = workspace(db, user)
    row = db.scalar(
        select(Appointment).where(
            Appointment.id == appointment_id, Appointment.workspace_id == w.id
        )
    )
    if row is None:
        raise AppError(404, "NOT_FOUND", "Запись не найдена.")
    resource_lock(db, w.id, row.resource_id)
    db.refresh(row)  # после ожидания блокировки читаем актуальный статус
    if body.status != "cancelled":
        available(db, row)
    row.status = body.status
    audit(db, user, "appointment.status", row.id)
    db.commit()
    return out(row)


@router.get("/app/pilots")
def pilot_list(
    status: str | None = None,
    limit: int = 25,
    cursor: str | None = None,
    _user: User = Depends(require_owner),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    from app.services import pilot

    if (
        status not in (None, "new", "contacted", "accepted", "declined", "spam")
        or not 1 <= limit <= 100
        or (cursor is not None and len(cursor) > 512)
    ):
        raise AppError(422, "VALIDATION_ERROR", "Проверьте фильтр списка.")
    rows, next_cursor = pilot.list_requests(db, status, limit, cursor)
    return {"items": [pilot.out(row) for row in rows], "next_cursor": next_cursor}


@router.patch("/app/pilots/{request_id}")
def pilot_update(
    request_id: uuid.UUID,
    body: PilotRequestPatch,
    user: User = Depends(require_owner_csrf),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    from app.services import pilot

    return pilot.out(
        pilot.update_request(db, user.id, request_id, body.status, body.note)
    ).model_dump(mode="json")
