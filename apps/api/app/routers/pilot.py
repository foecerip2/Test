"""Заявки на пилот AutoFlow: публичный приём с лендинга и кабинет владельца."""

from __future__ import annotations

import json
import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.config import Settings
from app.db import get_db
from app.deps import client_ip, get_settings, require_owner, require_owner_csrf
from app.models import User
from app.pilot_schemas import (
    PilotAccepted,
    PilotRequestIn,
    PilotRequestOut,
    PilotRequestPatch,
    PilotRequestsOut,
    PilotStatus,
)
from app.security import AppError
from app.services import pilot as svc

router = APIRouter(prefix="/api/v1/autoflow", tags=["autoflow"])

PUBLIC_PATH = "/api/v1/autoflow/pilot-requests"
MAX_BODY = 8192


async def read_limited_body(request: Request) -> bytes:
    """Читает тело потоком и обрывает при превышении лимита (в т.ч. без Content-Length)."""
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > MAX_BODY:
        raise AppError(413, "PAYLOAD_TOO_LARGE", "Слишком большой запрос.")
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_BODY:
            raise AppError(413, "PAYLOAD_TOO_LARGE", "Слишком большой запрос.")
        chunks.append(chunk)
    return b"".join(chunks)


def _is_honeypot_filled(payload: dict[str, Any]) -> bool:
    value = payload.get("website")
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    return True  # не строка (число, список…) — так форма не отправляет


@router.post("/pilot-requests", response_model=PilotAccepted, status_code=202)
def create_pilot_request(
    request: Request,
    body: Annotated[bytes, Depends(read_limited_body)],
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> PilotAccepted:
    """Публичный приём заявки (без входа и CSRF; Origin проверяет middleware).

    Ответ всегда `202 {"status":"accepted"}`: дубль и honeypot неотличимы от успеха."""
    ctype = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if ctype != "application/json":
        raise AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Ожидается application/json.")
    try:
        payload = json.loads(body)
    except (ValueError, RecursionError) as exc:
        raise AppError(422, "VALIDATION_ERROR", "Проверьте введённые данные.") from exc
    if not isinstance(payload, dict):
        raise AppError(422, "VALIDATION_ERROR", "Проверьте введённые данные.")
    if _is_honeypot_filled(payload):
        return PilotAccepted()  # без записи и без учёта в лимитах
    try:
        data = PilotRequestIn.model_validate(payload)
    except ValidationError as exc:
        raise AppError(422, "VALIDATION_ERROR", "Проверьте введённые данные.") from exc
    svc.submit(db, settings, data, client_ip(request, settings), request.headers.get("user-agent"))
    return PilotAccepted()


@router.get("/pilot-requests", response_model=PilotRequestsOut)
def list_pilot_requests(
    status: PilotStatus | None = None,
    limit: int = Query(default=50, ge=1, le=100),
    cursor: str | None = Query(default=None, max_length=512),
    _owner: User = Depends(require_owner),
    db: Session = Depends(get_db),
) -> PilotRequestsOut:
    rows, next_cursor = svc.list_requests(db, status, limit, cursor)
    return PilotRequestsOut(items=[svc.out(r) for r in rows], next_cursor=next_cursor)


@router.patch("/pilot-requests/{request_id}", response_model=PilotRequestOut)
def patch_pilot_request(
    request_id: uuid.UUID,
    body: PilotRequestPatch,
    owner: User = Depends(require_owner_csrf),
    db: Session = Depends(get_db),
) -> PilotRequestOut:
    row = svc.update_request(db, owner.id, request_id, body.status, body.note)
    return svc.out(row)
