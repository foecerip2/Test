"""Схемы очереди задач, кампаний и реестра источников (snake_case, как в остальном API)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

JobState = Literal["queued", "running", "succeeded", "failed", "cancelled"]
CampaignStatus = Literal["running", "paused", "done"]
ShortText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]


class JobOut(BaseModel):
    id: uuid.UUID
    type: str
    state: JobState
    attempts: int
    max_attempts: int
    run_after: datetime
    created_at: datetime
    updated_at: datetime
    cancel_requested: bool
    company_id: uuid.UUID | None
    campaign_id: uuid.UUID | None
    last_error: str | None
    result: dict[str, Any] | None


class JobPageOut(BaseModel):
    items: list[JobOut]
    has_more: bool
    next_cursor: str | None


class JobEnqueuedOut(BaseModel):
    job_id: uuid.UUID


class CampaignFilter(BaseModel):
    model_config = ConfigDict(extra="forbid")

    #: Минимальная текущая оценка компании (0–100); не задано — любая.
    score_min: int | None = Field(default=None, ge=0, le=100)


class CampaignIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: ShortText
    regions: list[ShortText] = Field(default_factory=list, max_length=50)
    categories: list[ShortText] = Field(default_factory=list, max_length=50)
    filter: CampaignFilter = Field(default_factory=CampaignFilter)
    per_day_limit: int = Field(default=50, ge=1, le=1000)


class CampaignPatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["running", "paused"]


class CampaignProgressOut(BaseModel):
    enqueued_total: int
    enqueued_today: int
    last_run_at: datetime | None
    jobs: dict[str, int]


class CampaignOut(BaseModel):
    id: uuid.UUID
    name: str
    regions: list[str]
    categories: list[str]
    filter: CampaignFilter
    per_day_limit: int
    status: CampaignStatus
    progress: CampaignProgressOut
    created_at: datetime
    updated_at: datetime


class CampaignListOut(BaseModel):
    items: list[CampaignOut]


class CampaignRunOut(BaseModel):
    enqueued: int
    skipped_active: int
    remaining_today: int
    status: CampaignStatus


class SourceOut(BaseModel):
    id: str
    name: str
    enabled: bool
    description: str
    rules: list[str]
    retention_days: int | None
    disabled_reason: str | None


class SourceListOut(BaseModel):
    items: list[SourceOut]
