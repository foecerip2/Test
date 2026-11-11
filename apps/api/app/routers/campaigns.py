"""Кампании: создание, список, пауза/возобновление, запуск (постановка задач проверки)."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.deps import require_active_user, require_active_user_csrf
from app.job_schemas import (
    CampaignIn,
    CampaignListOut,
    CampaignOut,
    CampaignPatchIn,
    CampaignRunOut,
)
from app.models import Campaign, User
from app.services import campaigns as svc
from app.services import companies as company_svc

router = APIRouter(prefix="/api/v1/campaigns", tags=["campaigns"])


@router.post("", response_model=CampaignOut, status_code=201)
def create_campaign(
    body: CampaignIn,
    user: User = Depends(require_active_user_csrf),
    db: Session = Depends(get_db),
) -> CampaignOut:
    c = svc.create_campaign(db, body, user.id)
    company_svc.add_audit(
        db,
        user.id,
        "campaign.create",
        "campaign",
        str(c.id),
        {"regions": len(c.regions), "categories": len(c.categories), "per_day": c.per_day_limit},
    )
    db.commit()
    return svc.campaign_out(db, c)


@router.get("", response_model=CampaignListOut)
def list_campaigns(
    _user: User = Depends(require_active_user), db: Session = Depends(get_db)
) -> CampaignListOut:
    rows = db.scalars(
        select(Campaign).order_by(Campaign.created_at.desc(), Campaign.id.desc()).limit(200)
    ).all()
    return CampaignListOut(items=[svc.campaign_out(db, c) for c in rows])


@router.get("/{campaign_id}", response_model=CampaignOut)
def get_campaign(
    campaign_id: uuid.UUID,
    _user: User = Depends(require_active_user),
    db: Session = Depends(get_db),
) -> CampaignOut:
    return svc.campaign_out(db, svc.get_campaign(db, campaign_id))


@router.patch("/{campaign_id}", response_model=CampaignOut)
def patch_campaign(
    campaign_id: uuid.UUID,
    body: CampaignPatchIn,
    user: User = Depends(require_active_user_csrf),
    db: Session = Depends(get_db),
) -> CampaignOut:
    c = svc.get_campaign(db, campaign_id)
    if c.status != body.status:
        old = c.status
        c.status = body.status
        company_svc.add_audit(
            db,
            user.id,
            "campaign.pause" if body.status == "paused" else "campaign.resume",
            "campaign",
            str(c.id),
            {"from": old, "to": body.status},
        )
        db.commit()
    return svc.campaign_out(db, c)


@router.post("/{campaign_id}/run", response_model=CampaignRunOut)
def run_campaign(
    campaign_id: uuid.UUID,
    user: User = Depends(require_active_user_csrf),
    db: Session = Depends(get_db),
) -> CampaignRunOut:
    c = svc.get_campaign(db, campaign_id)
    res = svc.run_campaign(db, c, user.id)
    company_svc.add_audit(
        db,
        user.id,
        "campaign.run",
        "campaign",
        str(c.id),
        {"enqueued": res.enqueued, "skipped_active": res.skipped_active},
    )
    db.commit()
    return CampaignRunOut.model_validate(
        {
            "enqueued": res.enqueued,
            "skipped_active": res.skipped_active,
            "remaining_today": res.remaining_today,
            "status": res.status,
        }
    )
