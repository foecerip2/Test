"""Компании: список, карточка, правка стадии/заметки, отклонение, экспорт CSV."""

from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.company_schemas import CompanyDetailOut, CompanyPageOut, CompanyPatchIn
from app.db import get_db
from app.deps import require_active_user, require_active_user_csrf
from app.job_schemas import JobEnqueuedOut
from app.models import User
from app.security import AppError
from app.services import companies as svc
from app.services import jobs
from app.services.companies import CompanyFilter, Direction, SortKey
from app.services.job_handlers import ENRICH_COMPANY

router = APIRouter(prefix="/api/v1/companies", tags=["companies"])

StatusKey = Literal["new", "contacted", "replied", "interested", "pilot", "refused", "rejected"]


def _default_dir(sort: SortKey) -> Direction:
    return "asc" if sort == "name" else "desc"


def _filter(
    query: str | None,
    city: str | None,
    score_min: int | None,
    status: StatusKey | None,
    sort: SortKey,
    dir_: Direction | None,
) -> CompanyFilter:
    return CompanyFilter(
        query=query,
        city=city,
        score_min=score_min,
        status=status,
        sort=sort,
        dir=dir_ or _default_dir(sort),
    )


@router.get("", response_model=CompanyPageOut)
def list_companies(
    query: str | None = Query(default=None, max_length=200),
    city: str | None = Query(default=None, max_length=120),
    score_min: int | None = Query(default=None, ge=0, le=100),
    status: StatusKey | None = None,
    sort: SortKey = "score",
    dir: Direction | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    cursor: str | None = Query(default=None, max_length=512),
    _user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> CompanyPageOut:
    f = _filter(query, city, score_min, status, sort, dir)
    page = svc.list_companies(db, f, limit, cursor)
    return CompanyPageOut(
        items=[svc.company_out(c) for c in page.items],
        total=page.total,
        cities=page.cities,
        has_more=page.has_more,
        next_cursor=page.next_cursor,
    )


# Маршрут /export объявлен раньше /{company_id}, чтобы не перехватываться параметром пути.
@router.get("/export")
def export_companies(
    request: Request,
    query: str | None = Query(default=None, max_length=200),
    city: str | None = Query(default=None, max_length=120),
    score_min: int | None = Query(default=None, ge=0, le=100),
    status: StatusKey | None = None,
    sort: SortKey = "score",
    dir: Direction | None = None,
    user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    f = _filter(query, city, score_min, status, sort, dir)
    svc.add_audit(
        db,
        user.id,
        "company.export",
        "company",
        "*",
        {
            "query": bool(query),
            "city": city,
            "score_min": score_min,
            "status": status,
            "sort": f.sort,
            "dir": f.dir,
        },
    )
    db.commit()
    return StreamingResponse(
        svc.export_csv_stream(request.app.state.session_factory, f),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="companies.csv"'},
    )


@router.get("/{company_id}", response_model=CompanyDetailOut)
def get_company(
    company_id: uuid.UUID,
    _user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> CompanyDetailOut:
    return svc.detail_out(db, svc.get_company(db, company_id))


@router.patch("/{company_id}", response_model=CompanyDetailOut)
def patch_company(
    company_id: uuid.UUID,
    body: CompanyPatchIn,
    user: User = Depends(require_active_user_csrf),
    db: Session = Depends(get_db),
) -> CompanyDetailOut:
    company = svc.get_company(db, company_id)
    if body.stage is not None:
        svc.change_stage(db, company, body.stage, body.expected_stage, user.id)
    if body.note is not None:
        svc.set_note(db, company, body.note, user.id)
    db.commit()
    db.refresh(company)
    return svc.detail_out(db, company)


@router.post("/{company_id}/enrich", status_code=202, response_model=JobEnqueuedOut)
def enrich_company(
    company_id: uuid.UUID,
    user: User = Depends(require_active_user_csrf),
    db: Session = Depends(get_db),
) -> JobEnqueuedOut:
    """Ставит в очередь проверку сайта компании (факты с доказательствами и пересчёт оценки)."""
    company = svc.get_company(db, company_id)
    if not company.website and not company.canonical_domain:
        raise AppError(422, "NO_WEBSITE", "У компании не указан сайт — проверять нечего.")
    try:
        job = jobs.enqueue(
            db,
            ENRICH_COMPANY,
            {"company_id": str(company.id)},
            created_by=user.id,
            dedupe_key=jobs.dedupe_key_for(ENRICH_COMPANY, company.id),
        )
    except jobs.DuplicateJobError as exc:
        raise AppError(
            409,
            "JOB_ALREADY_ACTIVE",
            "Проверка этой компании уже в очереди или выполняется.",
            extra={"job_id": str(exc.existing_id)},
        ) from None
    svc.add_audit(
        db, user.id, "company.enrich", "company", str(company.id), {"job_id": str(job.id)}
    )
    db.commit()
    return JobEnqueuedOut(job_id=job.id)


@router.post("/{company_id}/reject", response_model=CompanyDetailOut)
def reject_company(
    company_id: uuid.UUID,
    user: User = Depends(require_active_user_csrf),
    db: Session = Depends(get_db),
) -> CompanyDetailOut:
    company = svc.get_company(db, company_id)
    svc.reject_company(db, company, user.id)
    db.commit()
    db.refresh(company)
    return svc.detail_out(db, company)
