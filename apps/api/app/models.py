"""Модели БД. Совместимы с PostgreSQL и SQLite (тесты)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class UTCDateTime(sa.types.TypeDecorator[datetime]):
    """Всегда timezone-aware UTC (SQLite хранит naive)."""

    impl = sa.DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: sa.Dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)

    def process_result_value(self, value: datetime | None, dialect: sa.Dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)


JSONType = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def _now() -> datetime:
    return datetime.now(UTC)


class User(Base):
    __tablename__ = "users"
    __table_args__ = (sa.CheckConstraint("email = lower(email)", name="ck_users_email_lower"),)

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(sa.String(254), unique=True, nullable=False)
    role: Mapped[str] = mapped_column(sa.String(16), nullable=False, default="user")
    status: Mapped[str] = mapped_column(sa.String(16), nullable=False, default="pending")
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime, nullable=False, default=_now, server_default=sa.func.now()
    )
    last_login_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)


class OtpChallenge(Base):
    __tablename__ = "otp_challenges"

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    email: Mapped[str] = mapped_column(sa.String(254), nullable=False, index=True)
    code_hmac: Mapped[str] = mapped_column(sa.String(64), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)
    attempts: Mapped[int] = mapped_column(sa.Integer, nullable=False, default=0, server_default="0")
    sends: Mapped[int] = mapped_column(sa.Integer, nullable=False, default=1, server_default="1")
    last_sent_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    ip_hash: Mapped[str | None] = mapped_column(sa.String(64), nullable=True)


class SessionRow(Base):
    __tablename__ = "sessions"

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    token_hash: Mapped[str] = mapped_column(sa.String(64), unique=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime, nullable=False, default=_now, server_default=sa.func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    ip_hash: Mapped[str | None] = mapped_column(sa.String(64), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(sa.String(256), nullable=True)


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=uuid.uuid4)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(sa.Uuid, nullable=True, index=True)
    action: Mapped[str] = mapped_column(sa.String(64), nullable=False)
    entity: Mapped[str | None] = mapped_column(sa.String(64), nullable=True)
    entity_id: Mapped[str | None] = mapped_column(sa.String(64), nullable=True)
    meta: Mapped[dict[str, Any] | None] = mapped_column(JSONType, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime, nullable=False, default=_now, server_default=sa.func.now()
    )


class RateLimitEvent(Base):
    """События для скользящих лимитов (хранятся в БД, переживают рестарт)."""

    __tablename__ = "rate_limits"
    __table_args__ = (sa.Index("ix_rate_limits_scope_key_created", "scope", "key", "created_at"),)

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=uuid.uuid4)
    scope: Mapped[str] = mapped_column(sa.String(32), nullable=False)
    key: Mapped[str] = mapped_column(sa.String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False)


COMPANY_STATES = ("discovered", "verified", "scored", "shortlisted", "rejected", "archived")
CRM_STAGES = ("new", "contacted", "replied", "interested", "pilot", "lost")
FACT_KINDS = ("confirmed", "hypothesis")


def _in(col: str, values: tuple[str, ...]) -> str:
    return f"{col} IN ({', '.join(repr(v) for v in values)})"


class Company(Base):
    """Организация. Только данные организации; контакты и согласия — отдельным шагом."""

    __tablename__ = "companies"
    __table_args__ = (
        sa.CheckConstraint(_in("state", COMPANY_STATES), name="ck_companies_state"),
        sa.CheckConstraint(_in("stage", CRM_STAGES), name="ck_companies_stage"),
        sa.CheckConstraint("score >= 0 AND score <= 100", name="ck_companies_score"),
        # ИНН уникален только когда задан (partial unique index, работает в PostgreSQL и SQLite).
        sa.Index(
            "uq_companies_inn",
            "inn",
            unique=True,
            postgresql_where=sa.text("inn IS NOT NULL"),
            sqlite_where=sa.text("inn IS NOT NULL"),
        ),
        sa.Index("ix_companies_city_norm", "city_norm"),
        sa.Index("ix_companies_canonical_domain", "canonical_domain"),
        sa.Index("ix_companies_normalized_name", "normalized_name"),
        sa.Index("ix_companies_score", "score"),
        sa.Index("ix_companies_updated_at", "updated_at"),
        sa.Index("ix_companies_created_at", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(sa.String(300), nullable=False)
    normalized_name: Mapped[str] = mapped_column(sa.String(300), nullable=False)
    inn: Mapped[str | None] = mapped_column(sa.String(12), nullable=True)
    region: Mapped[str | None] = mapped_column(sa.String(120), nullable=True)
    city: Mapped[str] = mapped_column(sa.String(120), nullable=False)
    city_norm: Mapped[str] = mapped_column(sa.String(120), nullable=False)
    category: Mapped[str] = mapped_column(sa.String(200), nullable=False)
    website: Mapped[str | None] = mapped_column(sa.String(300), nullable=True)
    canonical_domain: Mapped[str | None] = mapped_column(sa.String(253), nullable=True)
    state: Mapped[str] = mapped_column(
        sa.String(16), nullable=False, default="discovered", server_default="discovered"
    )
    stage: Mapped[str] = mapped_column(
        sa.String(16), nullable=False, default="new", server_default="new"
    )
    note: Mapped[str] = mapped_column(sa.Text, nullable=False, default="", server_default="")
    source_label: Mapped[str] = mapped_column(sa.String(120), nullable=False)
    demo: Mapped[bool] = mapped_column(
        sa.Boolean, nullable=False, default=False, server_default=sa.false()
    )
    duplicate_candidate: Mapped[bool] = mapped_column(
        sa.Boolean, nullable=False, default=False, server_default=sa.false()
    )
    # Текущая оценка (денормализация lead_scores.score — для сортировки и индекса).
    score: Mapped[int] = mapped_column(sa.Integer, nullable=False, default=0, server_default="0")
    # Нижний регистр, ё->е: поиск без зависимости от регистра в SQLite и PostgreSQL.
    search_text: Mapped[str] = mapped_column(sa.Text, nullable=False, default="", server_default="")
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime, nullable=False, default=_now, server_default=sa.func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime, nullable=False, default=_now, server_default=sa.func.now()
    )


class CompanyFact(Base):
    __tablename__ = "company_facts"
    __table_args__ = (
        sa.CheckConstraint(_in("kind", FACT_KINDS), name="ck_company_facts_kind"),
        sa.CheckConstraint(
            "kind = 'hypothesis' OR (evidence_url IS NOT NULL AND evidence_excerpt IS NOT NULL)",
            name="ck_company_facts_evidence",
        ),
        sa.CheckConstraint("confidence >= 0 AND confidence <= 1", name="ck_company_facts_conf"),
        sa.Index("ix_company_facts_company_kind", "company_id", "kind"),
    )

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=uuid.uuid4)
    company_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(sa.String(16), nullable=False)
    text: Mapped[str] = mapped_column(sa.Text, nullable=False)
    evidence_url: Mapped[str | None] = mapped_column(sa.String(2000), nullable=True)
    evidence_excerpt: Mapped[str | None] = mapped_column(sa.Text, nullable=True)
    observed_at: Mapped[datetime] = mapped_column(UTCDateTime, nullable=False, default=_now)
    confidence: Mapped[float] = mapped_column(sa.Float, nullable=False, default=0.5)


class LeadScore(Base):
    """Текущий разбор оценки компании (одна строка на компанию; история — в activity_events)."""

    __tablename__ = "lead_scores"
    __table_args__ = (
        sa.CheckConstraint("score >= 0 AND score <= 100", name="ck_lead_scores_score"),
        sa.UniqueConstraint("company_id", name="uq_lead_scores_company"),
    )

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=uuid.uuid4)
    company_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False
    )
    score: Mapped[int] = mapped_column(sa.Integer, nullable=False)
    rule_version: Mapped[str] = mapped_column(sa.String(32), nullable=False)
    reasons: Mapped[list[dict[str, Any]]] = mapped_column(JSONType, nullable=False)
    # Входные данные правил (ScoreInput) — чтобы пересчитывать оценку детерминированно.
    inputs: Mapped[dict[str, Any]] = mapped_column(JSONType, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime, nullable=False, default=_now, server_default=sa.func.now()
    )


class ImportJob(Base):
    """Запись о выполненном импорте. Сам файл не хранится."""

    __tablename__ = "import_jobs"
    __table_args__ = (
        sa.CheckConstraint("status IN ('succeeded', 'failed')", name="ck_import_jobs_status"),
    )

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("users.id"), nullable=False, index=True
    )
    status: Mapped[str] = mapped_column(sa.String(16), nullable=False)
    rows_total: Mapped[int] = mapped_column(sa.Integer, nullable=False, default=0)
    rows_added: Mapped[int] = mapped_column(sa.Integer, nullable=False, default=0)
    rows_skipped: Mapped[int] = mapped_column(sa.Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime, nullable=False, default=_now, server_default=sa.func.now()
    )


class ActivityEvent(Base):
    """Журнал событий по компании. Append-only: ORM-обновление и удаление запрещены."""

    __tablename__ = "activity_events"
    __table_args__ = (sa.Index("ix_activity_events_company_created", "company_id", "created_at"),)

    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=uuid.uuid4)
    company_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("companies.id", ondelete="CASCADE"), nullable=False
    )
    event_type: Mapped[str] = mapped_column(sa.String(48), nullable=False)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(sa.Uuid, nullable=True)
    payload_redacted: Mapped[dict[str, Any] | None] = mapped_column(JSONType, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime, nullable=False, default=_now, server_default=sa.func.now()
    )


@sa.event.listens_for(ActivityEvent, "before_update")
@sa.event.listens_for(ActivityEvent, "before_delete")
def _activity_append_only(*_: object) -> None:
    raise RuntimeError("activity_events — append-only: изменение и удаление запрещены")
