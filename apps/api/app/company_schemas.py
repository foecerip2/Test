"""Схемы запросов и ответов для компаний, импорта и дашборда (snake_case, как в auth)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

CrmStage = Literal["new", "contacted", "replied", "interested", "pilot", "lost"]
CompanyState = Literal["discovered", "verified", "scored", "shortlisted", "rejected", "archived"]
Tone = Literal["neutral", "green", "amber", "red"]
NOTE_MAX = 2000


class DisplayOut(BaseModel):
    key: str
    label: str
    tone: Tone


class CompanyOut(BaseModel):
    id: uuid.UUID
    name: str
    city: str
    category: str
    website: str | None
    domain: str | None
    inn: str | None
    state: CompanyState
    stage: CrmStage
    score: int
    display: DisplayOut
    source_label: str
    created_at: datetime
    updated_at: datetime
    demo: bool
    duplicate_candidate: bool


class CompanyPageOut(BaseModel):
    items: list[CompanyOut]
    total: int
    cities: list[str]
    has_more: bool
    next_cursor: str | None


class FactOut(BaseModel):
    id: uuid.UUID
    text: str
    kind: Literal["confirmed", "hypothesis"]
    evidence_url: str | None
    evidence_excerpt: str | None
    observed_at: datetime
    confidence: float


class ScoreReasonOut(BaseModel):
    rule: str
    label: str
    points: int
    max: int
    note: str


class ActivityOut(BaseModel):
    id: uuid.UUID
    event_type: str
    icon: str
    title: str
    text: str
    at: datetime
    company_id: uuid.UUID
    company_name: str | None = None


class CompanyDetailOut(CompanyOut):
    note: str
    facts: list[FactOut]
    score_reasons: list[ScoreReasonOut]
    score_version: str | None
    history: list[ActivityOut]
    # Заглушки до следующих шагов (контакты/согласия, черновики): форма совместима с UI.
    contacts: list[dict[str, Any]] = Field(default_factory=list)
    draft_id: str | None = None


class CompanyPatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    stage: CrmStage | None = None
    note: Annotated[str, StringConstraints(max_length=NOTE_MAX)] | None = None
    #: Оптимистичная проверка: если текущая стадия другая — 409 STAGE_CONFLICT.
    expected_stage: CrmStage | None = None

    @model_validator(mode="after")
    def _something_to_change(self) -> CompanyPatchIn:
        if self.stage is None and self.note is None:
            raise ValueError("нужно передать stage или note")
        if self.expected_stage is not None and self.stage is None:
            raise ValueError("expected_stage имеет смысл только вместе со stage")
        return self


class ImportTextIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str


class ImportDuplicateOut(BaseModel):
    kind: Literal["exact", "candidate", "in_file"]
    of: str


class ImportRowOut(BaseModel):
    line: int
    name: str
    city: str
    category: str
    website: str | None
    inn: str | None
    issues: list[str]
    duplicate: ImportDuplicateOut | None


class ImportSummaryOut(BaseModel):
    total: int
    importable: int
    with_issues: int
    exact: int
    in_file: int
    candidates: int


class ImportDryRunOut(BaseModel):
    dry_run: Literal[True] = True
    rows: list[ImportRowOut]
    missing_columns: list[str]
    summary: ImportSummaryOut


class ImportCommitOut(BaseModel):
    dry_run: Literal[False] = False
    job_id: uuid.UUID
    rows_total: int
    added: int
    skipped: int
    candidates: int
    summary: ImportSummaryOut


class DashboardOut(BaseModel):
    companies_total: int
    companies_week: int
    suitable: int
    score_threshold: int
    by_stage: dict[str, int]
    by_state: dict[str, int]
    top_companies: list[CompanyOut]
    recent: list[ActivityOut]
    # Новые заявки на пилот AutoFlow: только для owner (у остальных null).
    pilot_requests_new: int | None = None
