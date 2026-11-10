"""Модель данных Фазы 2 (подмножество MD §6). Все tenant-ресурсы несут organization_id. Время — UTC."""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


def _pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


def _now() -> Mapped[dt.datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class Organization(Base):
    __tablename__ = "organizations"
    id: Mapped[uuid.UUID] = _pk()
    name: Mapped[str] = mapped_column(String(120))
    ai_mode: Mapped[str] = mapped_column(String(10), default="byok", server_default="byok")
    created_at: Mapped[dt.datetime] = _now()


class User(Base):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = _pk()
    email: Mapped[str] = mapped_column(String(254), unique=True)  # всегда в нижнем регистре
    name: Mapped[str] = mapped_column(String(120), default="")
    password_hash: Mapped[str] = mapped_column(String(255))
    totp_secret_enc: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)  # AEAD
    totp_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    totp_last_step: Mapped[int] = mapped_column(BigInteger, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[dt.datetime] = _now()


class Membership(Base):
    __tablename__ = "memberships"
    __table_args__ = (
        UniqueConstraint("organization_id", "user_id"),
        CheckConstraint("role in ('owner','operator','viewer')", name="ck_membership_role"),
    )
    id: Mapped[uuid.UUID] = _pk()
    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[dt.datetime] = _now()


class UserSession(Base):
    __tablename__ = "sessions"
    __table_args__ = (
        CheckConstraint("stage in ('pending_2fa','needs_2fa_setup','active')", name="ck_session_stage"),
    )
    id: Mapped[uuid.UUID] = _pk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    csrf_token: Mapped[str] = mapped_column(String(64))
    stage: Mapped[str] = mapped_column(String(20))
    ip: Mapped[str] = mapped_column(String(64), default="")
    user_agent: Mapped[str] = mapped_column(String(255), default="")
    created_at: Mapped[dt.datetime] = _now()
    last_seen_at: Mapped[dt.datetime] = _now()
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))


class LoginAttempt(Base):
    __tablename__ = "login_attempts"
    __table_args__ = (Index("ix_login_attempts_email_at", "email", "created_at"), Index("ix_login_attempts_ip_at", "ip", "created_at"))
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(254))
    ip: Mapped[str] = mapped_column(String(64))
    success: Mapped[bool] = mapped_column(Boolean)
    created_at: Mapped[dt.datetime] = _now()


class Server(Base):
    __tablename__ = "servers"
    __table_args__ = (
        UniqueConstraint("organization_id", "host", "port", "username", name="uq_server_target"),
        CheckConstraint("status in ('online','offline','unknown')", name="ck_server_status"),
    )
    id: Mapped[uuid.UUID] = _pk()
    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    host: Mapped[str] = mapped_column(String(253))
    port: Mapped[int] = mapped_column(Integer)
    username: Mapped[str] = mapped_column(String(32))
    os: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # закреплённый (pinned) ключ хоста: публичная часть в формате OpenSSH + SHA256-отпечаток
    host_key_openssh: Mapped[str] = mapped_column(Text)
    fingerprint: Mapped[str] = mapped_column(String(80))
    status: Mapped[str] = mapped_column(String(10), default="unknown")
    last_error_code: Mapped[str | None] = mapped_column(String(40), nullable=True)
    last_checked_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_success_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[dt.datetime] = _now()


class ServerCredential(Base):
    """Приватный ключ сервиса (на организацию), зашифрован AEAD; master key хранится вне БД."""

    __tablename__ = "server_credentials"
    __table_args__ = (
        Index("uq_org_credential_kind", "organization_id", "kind", unique=True, postgresql_where=text("server_id IS NULL")),
    )
    id: Mapped[uuid.UUID] = _pk()
    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    server_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("servers.id", ondelete="CASCADE"), nullable=True)
    kind: Mapped[str] = mapped_column(String(32))
    ciphertext: Mapped[bytes] = mapped_column(LargeBinary)
    public_key: Mapped[str] = mapped_column(Text)
    created_at: Mapped[dt.datetime] = _now()


class ServerMetricSample(Base):
    __tablename__ = "server_metric_samples"
    __table_args__ = (Index("ix_samples_server_time", "server_id", "sampled_at"),)
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    server_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("servers.id", ondelete="CASCADE"))
    sampled_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    source: Mapped[str] = mapped_column(String(10), default="ssh")
    os: Mapped[str | None] = mapped_column(String(120), nullable=True)
    uptime_seconds: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    cpu_percent: Mapped[float | None] = mapped_column(Float, nullable=True)
    ram_used_mb: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ram_total_mb: Mapped[int | None] = mapped_column(Integer, nullable=True)
    disk_used_gb: Mapped[float | None] = mapped_column(Float, nullable=True)
    disk_total_gb: Mapped[float | None] = mapped_column(Float, nullable=True)
    services: Mapped[Any] = mapped_column(JSONB, default=list)


class AuditEvent(Base):
    """Append-only: UPDATE/DELETE запрещены триггером БД (см. миграцию)."""

    __tablename__ = "audit_events"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    organization_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True, index=True)
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    action: Mapped[str] = mapped_column(String(64))
    target: Mapped[str] = mapped_column(String(255), default="")
    meta: Mapped[Any] = mapped_column(JSONB, default=dict)
    ip: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[dt.datetime] = _now()


# ───────────────────────── Фаза 3: AI, планы, подтверждения ─────────────────────────
class AiKey(Base):
    """Зашифрованный API-ключ или персональная сессия ChatGPT. API возвращает только метаданные."""

    __tablename__ = "ai_keys"
    __table_args__ = (UniqueConstraint("organization_id", "provider", name="uq_ai_key_org_provider"),
                      CheckConstraint("provider in ('openai','anthropic','deepseek','chatgpt')", name="ck_ai_provider"),
                      CheckConstraint("status in ('valid','unchecked','invalid')", name="ck_ai_key_status"))
    id: Mapped[uuid.UUID] = _pk()
    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    provider: Mapped[str] = mapped_column(String(16))
    model: Mapped[str] = mapped_column(String(64))
    key_enc: Mapped[bytes] = mapped_column(LargeBinary)
    masked: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(10), default="unchecked")
    created_at: Mapped[dt.datetime] = _now()


class Conversation(Base):
    __tablename__ = "conversations"
    __table_args__ = (UniqueConstraint("organization_id", "server_id", "user_id", name="uq_conversation_scope"),)
    id: Mapped[uuid.UUID] = _pk()
    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    server_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("servers.id", ondelete="CASCADE"))
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    created_at: Mapped[dt.datetime] = _now()


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (Index("ix_messages_conv_time", "conversation_id", "created_at"),
                      CheckConstraint("role in ('user','assistant')", name="ck_message_role"))
    id: Mapped[uuid.UUID] = _pk()
    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    conversation_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("conversations.id", ondelete="CASCADE"))
    role: Mapped[str] = mapped_column(String(10))
    content: Mapped[str] = mapped_column(Text)
    meta: Mapped[Any] = mapped_column(JSONB, default=dict)  # tools / observed / proposal; без секретов
    created_at: Mapped[dt.datetime] = _now()


class ActionPlan(Base):
    __tablename__ = "action_plans"
    __table_args__ = (CheckConstraint("status in ('waiting_approval','approved','rejected','expired')", name="ck_plan_status"),)
    id: Mapped[uuid.UUID] = _pk()
    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    server_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("servers.id", ondelete="CASCADE"), index=True)
    conversation_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    title: Mapped[str] = mapped_column(String(160))
    summary: Mapped[str] = mapped_column(Text, default="")
    steps: Mapped[Any] = mapped_column(JSONB)
    downtime: Mapped[str] = mapped_column(String(255), default="")
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    canonical_hash: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(20), default="waiting_approval")
    created_at: Mapped[dt.datetime] = _now()


class Approval(Base):
    """Подтверждение привязано к (plan, revision, hash, actor). Append-only (триггер)."""

    __tablename__ = "approvals"
    __table_args__ = (UniqueConstraint("plan_id", "revision", name="uq_approval_plan_revision"),)
    id: Mapped[uuid.UUID] = _pk()
    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    plan_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("action_plans.id", ondelete="CASCADE"))
    revision: Mapped[int] = mapped_column(Integer)
    canonical_hash: Mapped[str] = mapped_column(String(64))
    actor_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    created_at: Mapped[dt.datetime] = _now()


class AiUsage(Base):
    """Учёт токенов (BYOK: расходы оплачивает пользователь). Денежный ledger — Фаза 5."""

    __tablename__ = "ai_usage"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    provider: Mapped[str] = mapped_column(String(16))
    model: Mapped[str] = mapped_column(String(64))
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[dt.datetime] = _now()


class Job(Base):
    """Задание исполнителя. В этой версии существует ТОЛЬКО режим «репетиция» (mode='rehearsal'): проверки выполняются,
    команды на сервер не отправляются. CHECK на уровне БД не даёт создать задание другого режима."""

    __tablename__ = "jobs"
    __table_args__ = (
        CheckConstraint("mode in ('rehearsal')", name="ck_job_mode"),
        CheckConstraint("status in ('queued','running','succeeded','blocked','failed')", name="ck_job_status"),
        UniqueConstraint("plan_id", "plan_revision", "mode", name="uq_job_plan_revision_mode"),  # идемпотентность
        Index("ix_jobs_queue", "status", "created_at"),
    )
    id: Mapped[uuid.UUID] = _pk()
    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    plan_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("action_plans.id", ondelete="CASCADE"), index=True)
    server_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("servers.id", ondelete="CASCADE"), index=True)
    plan_revision: Mapped[int] = mapped_column(Integer)
    plan_hash: Mapped[str] = mapped_column(String(64))
    mode: Mapped[str] = mapped_column(String(12), default="rehearsal")
    status: Mapped[str] = mapped_column(String(10), default="queued")
    requested_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    lease_until: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    summary: Mapped[str] = mapped_column(String(255), default="")
    created_at: Mapped[dt.datetime] = _now()
    started_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class JobStep(Base):
    """Результат шага задания. Append-only (триггер БД): журнал нельзя переписать задним числом."""

    __tablename__ = "job_steps"
    __table_args__ = (
        CheckConstraint("status in ('rehearsed','blocked','failed','skipped')", name="ck_job_step_status"),
        UniqueConstraint("job_id", "ord", name="uq_job_step_order"),
    )
    id: Mapped[uuid.UUID] = _pk()
    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    job_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("jobs.id", ondelete="CASCADE"), index=True)
    ord: Mapped[int] = mapped_column(Integer)
    step_id: Mapped[str] = mapped_column(String(16))
    tool: Mapped[str] = mapped_column(String(48))
    status: Mapped[str] = mapped_column(String(10))
    checks: Mapped[Any] = mapped_column(JSONB)          # [{name, ok, detail}]
    planned_action: Mapped[str] = mapped_column(Text, default="")  # что БЫЛО БЫ выполнено (без секретов)
    created_at: Mapped[dt.datetime] = _now()


class Wallet(Base):
    """Кошелёк организации в целых минимальных единицах кредитов. Это КЭШ суммы ledger (источник истины — ledger_entries):
    CHECK на уровне БД не даёт балансу уйти в минус (available = balance - held >= 0). Обновляется только в той же транзакции, что и проводка."""

    __tablename__ = "wallets"
    __table_args__ = (
        CheckConstraint("balance >= 0", name="ck_wallet_balance_nonneg"),
        CheckConstraint("held >= 0", name="ck_wallet_held_nonneg"),
        CheckConstraint("held <= balance", name="ck_wallet_available_nonneg"),
    )
    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), primary_key=True)
    balance: Mapped[int] = mapped_column(BigInteger, default=0)
    held: Mapped[int] = mapped_column(BigInteger, default=0)
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Reservation(Base):
    """Резерв под будущее списание. Состояние меняется строго open → captured | released (один раз): защита от двойного списания."""

    __tablename__ = "ledger_reservations"
    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_reservation_amount_pos"),
        CheckConstraint("status in ('open','captured','released')", name="ck_reservation_status"),
        CheckConstraint("captured >= 0 and captured <= amount", name="ck_reservation_captured"),
        Index("ix_reservations_open", "status", "created_at"),
    )
    id: Mapped[uuid.UUID] = _pk()
    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    amount: Mapped[int] = mapped_column(BigInteger)
    captured: Mapped[int] = mapped_column(BigInteger, default=0)
    status: Mapped[str] = mapped_column(String(10), default="open")
    created_at: Mapped[dt.datetime] = _now()
    settled_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class LedgerEntry(Base):
    """Проводка. Append-only (триггер БД). Идемпотентность: UNIQUE (organization_id, idempotency_key)."""

    __tablename__ = "ledger_entries"
    __table_args__ = (
        CheckConstraint("kind in ('credit','reserve','capture','release','adjustment')", name="ck_ledger_kind"),
        CheckConstraint("amount <> 0", name="ck_ledger_amount_nonzero"),
        CheckConstraint("kind = 'adjustment' or amount > 0", name="ck_ledger_amount_sign"),
        UniqueConstraint("organization_id", "idempotency_key", name="uq_ledger_idempotency"),
        Index("ix_ledger_org_time", "organization_id", "created_at"),
    )
    id: Mapped[uuid.UUID] = _pk()
    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(10))
    amount: Mapped[int] = mapped_column(BigInteger)  # >0; только у adjustment допускается знак
    idempotency_key: Mapped[str] = mapped_column(String(80))
    reservation_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("ledger_reservations.id", ondelete="SET NULL"), nullable=True)
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    note: Mapped[str] = mapped_column(String(240), default="")
    model: Mapped[str | None] = mapped_column(String(64), nullable=True)
    tokens_in: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tokens_out: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[dt.datetime] = _now()


class PlatformModel(Base):
    """Модель платформы для режима Credits. Подключается ТОЛЬКО администратором платформы из админ-панели; ключ шифруется AEAD
    (привязка к id строки), наружу не отдаётся — только маска. Активна ровно одна (частичный уникальный индекс)."""

    __tablename__ = "platform_models"
    __table_args__ = (
        UniqueConstraint("provider", "model", name="uq_platform_model"),
        CheckConstraint("provider in ('openai','anthropic','deepseek')", name="ck_platform_provider"),
        CheckConstraint("status in ('valid','unchecked','invalid')", name="ck_platform_status"),
        CheckConstraint("price_in_per_1k > 0 and price_out_per_1k > 0", name="ck_platform_prices"),
        Index("uq_platform_model_active", "active", unique=True, postgresql_where=text("active")),
    )
    id: Mapped[uuid.UUID] = _pk()
    provider: Mapped[str] = mapped_column(String(16))
    model: Mapped[str] = mapped_column(String(64))
    key_enc: Mapped[bytes] = mapped_column(LargeBinary)
    masked: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(10), default="unchecked")
    active: Mapped[bool] = mapped_column(Boolean, default=False)
    price_in_per_1k: Mapped[int] = mapped_column(Integer)
    price_out_per_1k: Mapped[int] = mapped_column(Integer)
    price_list_version: Mapped[str] = mapped_column(String(40), default="")
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at: Mapped[dt.datetime] = _now()
