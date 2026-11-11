"""Заявки на пилот AutoFlow (pilot_requests)

Аддитивная миграция: только новая таблица; downgrade удаляет её (данные заявок теряются).

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-11
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "pilot_requests",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("business_name", sa.String(120), nullable=False),
        sa.Column("city", sa.String(80), nullable=False),
        sa.Column("contact_name", sa.String(80), nullable=False),
        sa.Column("phone", sa.String(16), nullable=True),
        sa.Column("email", sa.String(254), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="new"),
        sa.Column("note", sa.String(2000), nullable=False, server_default=""),
        sa.Column("consent_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consent_text_version", sa.String(32), nullable=False),
        sa.Column("ip_hash", sa.String(64), nullable=True),
        sa.Column("user_agent_short", sa.String(120), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint(
            "status IN ('new', 'contacted', 'accepted', 'declined', 'spam')",
            name="ck_pilot_requests_status",
        ),
        sa.CheckConstraint(
            "phone IS NOT NULL OR email IS NOT NULL", name="ck_pilot_requests_contact"
        ),
    )
    op.create_index("ix_pilot_requests_created_at", "pilot_requests", ["created_at"])
    op.create_index(
        "ix_pilot_requests_status_created_at", "pilot_requests", ["status", "created_at"]
    )
    op.create_index("ix_pilot_requests_phone", "pilot_requests", ["phone"])
    op.create_index("ix_pilot_requests_email", "pilot_requests", ["email"])


def downgrade() -> None:
    op.drop_index("ix_pilot_requests_email", table_name="pilot_requests")
    op.drop_index("ix_pilot_requests_phone", table_name="pilot_requests")
    op.drop_index("ix_pilot_requests_status_created_at", table_name="pilot_requests")
    op.drop_index("ix_pilot_requests_created_at", table_name="pilot_requests")
    op.drop_table("pilot_requests")
