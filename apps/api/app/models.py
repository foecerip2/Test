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
