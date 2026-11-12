"""Изолированные сессии и закрытое приложение AutoFlow (аддитивно)."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("leadhunter_member", sa.Boolean, nullable=False, server_default=sa.true()),
    )
    for table in ("sessions", "otp_challenges"):
        op.add_column(
            table,
            sa.Column("application", sa.String(16), nullable=False, server_default="leadhunter"),
        )
    op.create_table(
        "af_accounts",
        sa.Column("user_id", sa.Uuid, sa.ForeignKey("users.id"), primary_key=True),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("business_name", sa.String(120), nullable=False),
        sa.Column("city", sa.String(80), nullable=False),
        sa.Column("consent_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "af_workspaces",
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column("owner_id", sa.Uuid, sa.ForeignKey("users.id"), nullable=False, unique=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("city", sa.String(80), nullable=False),
        sa.Column("opens", sa.Integer, nullable=False),
        sa.Column("closes", sa.Integer, nullable=False),
    )
    op.create_table(
        "af_services",
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column("workspace_id", sa.Uuid, sa.ForeignKey("af_workspaces.id"), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("duration", sa.Integer, nullable=False),
        sa.Column("price", sa.Integer, nullable=False),
    )
    op.create_table(
        "af_resources",
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column("workspace_id", sa.Uuid, sa.ForeignKey("af_workspaces.id"), nullable=False),
        sa.Column("name", sa.String(80), nullable=False),
    )
    op.create_table(
        "af_appointments",
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column("workspace_id", sa.Uuid, sa.ForeignKey("af_workspaces.id"), nullable=False),
        sa.Column("service_id", sa.Uuid, sa.ForeignKey("af_services.id"), nullable=False),
        sa.Column("resource_id", sa.Uuid, sa.ForeignKey("af_resources.id"), nullable=False),
        sa.Column("day", sa.Date, nullable=False),
        sa.Column("starts", sa.Integer, nullable=False),
        sa.Column("ends", sa.Integer, nullable=False),
        sa.Column("customer", sa.String(80), nullable=False),
        sa.Column("phone", sa.String(16), nullable=False),
        sa.Column("note", sa.String(1000), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("consent_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "status IN ('new','confirmed','completed','cancelled')", name="ck_af_appointment_status"
        ),
        sa.CheckConstraint("ends > starts", name="ck_af_appointment_duration"),
    )
    for table in ("af_services", "af_resources", "af_appointments"):
        op.create_index(f"ix_{table}_workspace_id", table, ["workspace_id"])
    op.create_index("ix_af_appointment_resource_day", "af_appointments", ["resource_id", "day"])


def downgrade() -> None:
    op.drop_column("users", "leadhunter_member")
    for table in ("af_appointments", "af_resources", "af_services", "af_workspaces", "af_accounts"):
        op.drop_table(table)
    for table in ("otp_challenges", "sessions"):
        op.drop_column(table, "application")
