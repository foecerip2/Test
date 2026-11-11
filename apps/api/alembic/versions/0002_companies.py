"""Компании: companies, company_facts, lead_scores, import_jobs, activity_events

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-11
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

JSONType = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.create_table(
        "companies",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("name", sa.String(300), nullable=False),
        sa.Column("normalized_name", sa.String(300), nullable=False),
        sa.Column("inn", sa.String(12), nullable=True),
        sa.Column("region", sa.String(120), nullable=True),
        sa.Column("city", sa.String(120), nullable=False),
        sa.Column("city_norm", sa.String(120), nullable=False),
        sa.Column("category", sa.String(200), nullable=False),
        sa.Column("website", sa.String(300), nullable=True),
        sa.Column("canonical_domain", sa.String(253), nullable=True),
        sa.Column("state", sa.String(16), nullable=False, server_default="discovered"),
        sa.Column("stage", sa.String(16), nullable=False, server_default="new"),
        sa.Column("note", sa.Text(), nullable=False, server_default=""),
        sa.Column("source_label", sa.String(120), nullable=False),
        sa.Column("demo", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("duplicate_candidate", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("score", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("search_text", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint(
            "state IN ('discovered', 'verified', 'scored', 'shortlisted', 'rejected', 'archived')",
            name="ck_companies_state",
        ),
        sa.CheckConstraint(
            "stage IN ('new', 'contacted', 'replied', 'interested', 'pilot', 'lost')",
            name="ck_companies_stage",
        ),
        sa.CheckConstraint("score >= 0 AND score <= 100", name="ck_companies_score"),
    )
    op.create_index(
        "uq_companies_inn",
        "companies",
        ["inn"],
        unique=True,
        postgresql_where=sa.text("inn IS NOT NULL"),
        sqlite_where=sa.text("inn IS NOT NULL"),
    )
    op.create_index("ix_companies_city_norm", "companies", ["city_norm"])
    op.create_index("ix_companies_canonical_domain", "companies", ["canonical_domain"])
    op.create_index("ix_companies_normalized_name", "companies", ["normalized_name"])
    op.create_index("ix_companies_score", "companies", ["score"])
    op.create_index("ix_companies_updated_at", "companies", ["updated_at"])
    op.create_index("ix_companies_created_at", "companies", ["created_at"])

    op.create_table(
        "company_facts",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "company_id",
            sa.Uuid(),
            sa.ForeignKey("companies.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("evidence_url", sa.String(2000), nullable=True),
        sa.Column("evidence_excerpt", sa.Text(), nullable=True),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.CheckConstraint("kind IN ('confirmed', 'hypothesis')", name="ck_company_facts_kind"),
        sa.CheckConstraint(
            "kind = 'hypothesis' OR (evidence_url IS NOT NULL AND evidence_excerpt IS NOT NULL)",
            name="ck_company_facts_evidence",
        ),
        sa.CheckConstraint("confidence >= 0 AND confidence <= 1", name="ck_company_facts_conf"),
    )
    op.create_index("ix_company_facts_company_kind", "company_facts", ["company_id", "kind"])

    op.create_table(
        "lead_scores",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "company_id",
            sa.Uuid(),
            sa.ForeignKey("companies.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("score", sa.Integer(), nullable=False),
        sa.Column("rule_version", sa.String(32), nullable=False),
        sa.Column("reasons", JSONType, nullable=False),
        sa.Column("inputs", JSONType, nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint("score >= 0 AND score <= 100", name="ck_lead_scores_score"),
        sa.UniqueConstraint("company_id", name="uq_lead_scores_company"),
    )

    op.create_table(
        "import_jobs",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("rows_total", sa.Integer(), nullable=False),
        sa.Column("rows_added", sa.Integer(), nullable=False),
        sa.Column("rows_skipped", sa.Integer(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint("status IN ('succeeded', 'failed')", name="ck_import_jobs_status"),
    )
    op.create_index("ix_import_jobs_user_id", "import_jobs", ["user_id"])

    op.create_table(
        "activity_events",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "company_id",
            sa.Uuid(),
            sa.ForeignKey("companies.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("event_type", sa.String(48), nullable=False),
        sa.Column("actor_id", sa.Uuid(), nullable=True),
        sa.Column("payload_redacted", JSONType, nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index(
        "ix_activity_events_company_created", "activity_events", ["company_id", "created_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_activity_events_company_created", table_name="activity_events")
    op.drop_table("activity_events")
    op.drop_index("ix_import_jobs_user_id", table_name="import_jobs")
    op.drop_table("import_jobs")
    op.drop_table("lead_scores")
    op.drop_index("ix_company_facts_company_kind", table_name="company_facts")
    op.drop_table("company_facts")
    op.drop_index("ix_companies_created_at", table_name="companies")
    op.drop_index("ix_companies_updated_at", table_name="companies")
    op.drop_index("ix_companies_score", table_name="companies")
    op.drop_index("ix_companies_normalized_name", table_name="companies")
    op.drop_index("ix_companies_canonical_domain", table_name="companies")
    op.drop_index("ix_companies_city_norm", table_name="companies")
    op.drop_index("uq_companies_inn", table_name="companies")
    op.drop_table("companies")
