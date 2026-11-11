"""Очередь задач: список, карточка, отмена."""

from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import require_active_user, require_active_user_csrf
from app.job_schemas import JobOut, JobPageOut
from app.models import Job, User
from app.security import AppError
from app.services import companies as company_svc
from app.services import jobs as svc

router = APIRouter(prefix="/api/v1/jobs", tags=["jobs"])


def _uuid_or_none(value: object) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value))
    except ValueError:
        return None


def job_out(j: Job) -> JobOut:
    payload = j.payload or {}
    return JobOut.model_validate(
        {
            "id": j.id,
            "type": j.type,
            "state": j.state,
            "attempts": j.attempts,
            "max_attempts": j.max_attempts,
            "run_after": j.run_after,
            "created_at": j.created_at,
            "updated_at": j.updated_at,
            "cancel_requested": j.cancel_requested,
            "company_id": _uuid_or_none(payload.get("company_id"))
            if "company_id" in payload
            else None,
            "campaign_id": j.campaign_id,
            "last_error": j.last_error,
            "result": j.result,
        }
    )


@router.get("", response_model=JobPageOut)
def list_jobs(
    state: Literal["queued", "running", "succeeded", "failed", "cancelled"] | None = None,
    type: str | None = Query(default=None, max_length=48, alias="type"),
    limit: int = Query(default=50, ge=1, le=200),
    cursor: str | None = Query(default=None, max_length=512),
    _user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> JobPageOut:
    page = svc.list_jobs(db, state=state, job_type=type, limit=limit, cursor=cursor)
    return JobPageOut(
        items=[job_out(j) for j in page.items],
        has_more=page.has_more,
        next_cursor=page.next_cursor,
    )


@router.get("/{job_id}", response_model=JobOut)
def get_job(
    job_id: uuid.UUID,
    _user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> JobOut:
    return job_out(svc.get_job(db, job_id))


@router.post("/{job_id}/cancel", response_model=JobOut)
def cancel_job(
    job_id: uuid.UUID,
    user: User = Depends(require_active_user_csrf),
    db: Session = Depends(get_db),
) -> JobOut:
    try:
        job = svc.cancel(db, job_id)
    except svc.JobStateError as exc:
        raise AppError(
            409, "JOB_NOT_CANCELLABLE", "Задача уже завершена.", extra={"state": exc.state}
        ) from None
    company_svc.add_audit(
        db, user.id, "job.cancel", "job", str(job.id), {"type": job.type, "state": job.state}
    )
    db.commit()
    return job_out(job)
