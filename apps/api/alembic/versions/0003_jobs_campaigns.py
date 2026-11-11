"""Очередь задач (jobs) и кампании (campaigns)

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-11
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

JSONType = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
ACTIVE = "dedupe_key IS NOT NULL AND state IN ('queued', 'running')"


def upgrade() -> None:
    op.add_column("company_facts", sa.Column("source", sa.String(32), nullable=True))
    op.add_column("company_facts", sa.Column("fact_key", sa.String(48), nullable=True))
    op.create_table(
        "jobs",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("type", sa.String(48), nullable=False),
        sa.Column("payload", JSONType, nullable=False),
        sa.Column("state", sa.String(16), nullable=False, server_default="queued"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("max_attempts", sa.Integer(), nullable=False, server_default="3"),
        sa.Column(
            "run_after", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("locked_by", sa.String(64), nullable=True),
        sa.Column("locked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancel_requested", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("dedupe_key", sa.String(120), nullable=True),
        sa.Column("campaign_id", sa.Uuid(), nullable=True),
        sa.Column("last_error", sa.String(500), nullable=True),
        sa.Column("result", JSONType, nullable=True),
        sa.Column(
            "created_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint(
            "state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')",
            name="ck_jobs_state",
        ),
        sa.CheckConstraint("attempts >= 0 AND max_attempts >= 1", name="ck_jobs_attempts"),
    )
    op.create_index("ix_jobs_state_run_after", "jobs", ["state", "run_after"])
    op.create_index("ix_jobs_created_at", "jobs", ["created_at"])
    op.create_index("ix_jobs_campaign_created", "jobs", ["campaign_id", "created_at"])
    op.create_index(
        "uq_jobs_active_dedupe",
        "jobs",
        ["dedupe_key"],
        unique=True,
        postgresql_where=sa.text(ACTIVE),
        sqlite_where=sa.text(ACTIVE),
    )

    op.create_table(
        "campaigns",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("regions", JSONType, nullable=False),
        sa.Column("categories", JSONType, nullable=False),
        sa.Column("filter", JSONType, nullable=False),
        sa.Column("per_day_limit", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="running"),
        sa.Column("progress", JSONType, nullable=False),
        sa.Column(
            "created_by", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint("status IN ('running', 'paused', 'done')", name="ck_campaigns_status"),
        sa.CheckConstraint(
            "per_day_limit >= 1 AND per_day_limit <= 1000", name="ck_campaigns_limit"
        ),
    )
    op.create_index("ix_campaigns_status_created", "campaigns", ["status", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_campaigns_status_created", table_name="campaigns")
    op.drop_table("campaigns")
    op.drop_index("uq_jobs_active_dedupe", table_name="jobs")
    op.drop_index("ix_jobs_campaign_created", table_name="jobs")
    op.drop_index("ix_jobs_created_at", table_name="jobs")
    op.drop_index("ix_jobs_state_run_after", table_name="jobs")
    op.drop_table("jobs")
    with op.batch_alter_table("company_facts") as batch:
        batch.drop_column("fact_key")
        batch.drop_column("source")
