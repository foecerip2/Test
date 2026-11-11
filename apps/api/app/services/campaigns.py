"""Кампании: отбор непроверенных компаний и постановка задач проверки сайта."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import sqlalchemy as sa
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import security
from app.job_schemas import (
    CampaignFilter,
    CampaignIn,
    CampaignOut,
    CampaignProgressOut,
)
from app.models import ActivityEvent, Campaign, Company, Job
from app.security import AppError
from app.services import jobs
from app.services.companies import fold
from app.services.job_handlers import ENRICH_COMPANY
from app.services.normalize import normalize_city

BATCH = 200


def get_campaign(db: Session, campaign_id: uuid.UUID) -> Campaign:
    c = db.get(Campaign, campaign_id)
    if c is None:
        raise AppError(404, "NOT_FOUND", "Кампания не найдена.")
    return c


def day_start(now: datetime) -> datetime:
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


def enqueued_today(db: Session, campaign_id: uuid.UUID, now: datetime) -> int:
    return (
        db.scalar(
            select(func.count())
            .select_from(Job)
            .where(Job.campaign_id == campaign_id, Job.created_at >= day_start(now))
        )
        or 0
    )


def campaign_out(db: Session, c: Campaign, now: datetime | None = None) -> CampaignOut:
    now = now or security.now()
    rows = db.execute(
        select(Job.state, func.count()).where(Job.campaign_id == c.id).group_by(Job.state)
    ).all()
    by_state = {state: int(n) for state, n in rows}
    last_run = c.progress.get("last_run_at")
    return CampaignOut.model_validate(
        {
            "id": c.id,
            "name": c.name,
            "regions": list(c.regions),
            "categories": list(c.categories),
            "filter": CampaignFilter(**c.filter),
            "per_day_limit": c.per_day_limit,
            "status": c.status,
            "progress": CampaignProgressOut(
                enqueued_total=sum(by_state.values()),
                enqueued_today=enqueued_today(db, c.id, now),
                last_run_at=datetime.fromisoformat(last_run) if last_run else None,
                jobs=by_state,
            ),
            "created_at": c.created_at,
            "updated_at": c.updated_at,
        }
    )


def create_campaign(db: Session, body: CampaignIn, actor_id: uuid.UUID) -> Campaign:
    now = security.now()
    c = Campaign(
        name=body.name,
        regions=list(dict.fromkeys(body.regions)),
        categories=list(dict.fromkeys(body.categories)),
        filter=body.filter.model_dump(),
        per_day_limit=body.per_day_limit,
        status="running",
        progress={},
        created_by=actor_id,
        created_at=now,
        updated_at=now,
    )
    db.add(c)
    db.flush()
    return c


@dataclass
class RunResult:
    enqueued: int
    skipped_active: int
    remaining_today: int
    status: str


def _unchecked_query(c: Campaign) -> sa.Select[Any]:
    """Компании с сайтом, не отклонённые, без отказа и без завершённой проверки сайта."""
    checked = (
        select(ActivityEvent.id)
        .where(
            ActivityEvent.company_id == Company.id,
            ActivityEvent.event_type == "company.site_checked",
        )
        .exists()
    )
    stmt = select(Company).where(
        sa.or_(Company.website.is_not(None), Company.canonical_domain.is_not(None)),
        Company.state.not_in(("rejected", "archived")),
        Company.stage != "lost",
        ~checked,
    )
    score_min = c.filter.get("score_min")
    if score_min is not None:
        stmt = stmt.where(Company.score >= int(score_min))
    if c.regions:
        norms = {normalize_city(r) for r in c.regions}
        lowered = {r.lower() for r in c.regions}
        stmt = stmt.where(
            sa.or_(Company.city_norm.in_(norms), func.lower(Company.region).in_(lowered))
        )
    return stmt.order_by(Company.score.desc(), Company.created_at, Company.id)


def run_campaign(db: Session, c: Campaign, actor_id: uuid.UUID | None) -> RunResult:
    """Ставит задачи проверки (без дублей), не более `per_day_limit` за UTC-сутки."""
    if c.status != "running":
        raise AppError(
            409, "CAMPAIGN_NOT_RUNNING", "Кампания не запущена.", extra={"status": c.status}
        )
    now = security.now()
    left = c.per_day_limit - enqueued_today(db, c.id, now)
    wanted = [fold(x) for x in c.categories]
    enqueued = skipped = 0
    seen_any = False
    exhausted = False
    offset = 0
    stmt = _unchecked_query(c)
    while left > 0:
        batch = db.scalars(stmt.limit(BATCH).offset(offset)).all()
        if not batch:
            exhausted = True
            break
        offset += BATCH
        for company in batch:
            if wanted and not any(w in fold(company.category) for w in wanted):
                continue
            seen_any = True
            try:
                jobs.enqueue(
                    db,
                    ENRICH_COMPANY,
                    {"company_id": str(company.id)},
                    created_by=actor_id,
                    dedupe_key=jobs.dedupe_key_for(ENRICH_COMPANY, company.id),
                    campaign_id=c.id,
                    commit=True,
                )
            except jobs.DuplicateJobError:
                skipped += 1
                continue
            enqueued += 1
            left -= 1
            if left <= 0:
                break
    active_campaign_jobs = (
        db.scalar(
            select(func.count())
            .select_from(Job)
            .where(Job.campaign_id == c.id, Job.state.in_(("queued", "running")))
        )
        or 0
    )
    if exhausted and not seen_any and active_campaign_jobs == 0:
        c.status = "done"
    c.progress = {**c.progress, "last_run_at": now.isoformat()}
    c.updated_at = now
    return RunResult(
        enqueued=enqueued,
        skipped_active=skipped,
        remaining_today=max(0, left),
        status=c.status,
    )
