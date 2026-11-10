"""jobs and job_steps (executor rehearsal)

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-10 07:50:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = '0003'
down_revision: Union[str, Sequence[str], None] = '0002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('jobs',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('organization_id', sa.UUID(), nullable=False),
    sa.Column('plan_id', sa.UUID(), nullable=False),
    sa.Column('server_id', sa.UUID(), nullable=False),
    sa.Column('plan_revision', sa.Integer(), nullable=False),
    sa.Column('plan_hash', sa.String(length=64), nullable=False),
    sa.Column('mode', sa.String(length=12), nullable=False),
    sa.Column('status', sa.String(length=10), nullable=False),
    sa.Column('requested_by', sa.UUID(), nullable=True),
    sa.Column('lease_until', sa.DateTime(timezone=True), nullable=True),
    sa.Column('summary', sa.String(length=255), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
    sa.CheckConstraint("mode in ('rehearsal')", name='ck_job_mode'),
    sa.CheckConstraint("status in ('queued','running','succeeded','blocked','failed')", name='ck_job_status'),
    sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['plan_id'], ['action_plans.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['requested_by'], ['users.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['server_id'], ['servers.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('plan_id', 'plan_revision', 'mode', name='uq_job_plan_revision_mode')
    )
    op.create_index(op.f('ix_jobs_organization_id'), 'jobs', ['organization_id'], unique=False)
    op.create_index(op.f('ix_jobs_plan_id'), 'jobs', ['plan_id'], unique=False)
    op.create_index(op.f('ix_jobs_server_id'), 'jobs', ['server_id'], unique=False)
    op.create_index('ix_jobs_queue', 'jobs', ['status', 'created_at'], unique=False)
    op.create_table('job_steps',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('organization_id', sa.UUID(), nullable=False),
    sa.Column('job_id', sa.UUID(), nullable=False),
    sa.Column('ord', sa.Integer(), nullable=False),
    sa.Column('step_id', sa.String(length=16), nullable=False),
    sa.Column('tool', sa.String(length=48), nullable=False),
    sa.Column('status', sa.String(length=10), nullable=False),
    sa.Column('checks', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('planned_action', sa.Text(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("status in ('rehearsed','blocked','failed','skipped')", name='ck_job_step_status'),
    sa.ForeignKeyConstraint(['job_id'], ['jobs.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('job_id', 'ord', name='uq_job_step_order')
    )
    op.create_index(op.f('ix_job_steps_job_id'), 'job_steps', ['job_id'], unique=False)
    op.create_index(op.f('ix_job_steps_organization_id'), 'job_steps', ['organization_id'], unique=False)
    # Журнал шагов append-only: запрет UPDATE/DELETE на уровне БД (каскад от удаления задания/организации остаётся)
    op.execute("""
        CREATE FUNCTION job_steps_immutable() RETURNS trigger AS $$
        BEGIN
            IF TG_OP = 'UPDATE' THEN
                RAISE EXCEPTION 'job_steps is append-only';
            END IF;
            RETURN OLD;
        END;
        $$ LANGUAGE plpgsql
    """)
    op.execute("""
        CREATE TRIGGER job_steps_no_update
        BEFORE UPDATE ON job_steps
        FOR EACH ROW EXECUTE FUNCTION job_steps_immutable()
    """)


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS job_steps_no_update ON job_steps")
    op.execute("DROP FUNCTION IF EXISTS job_steps_immutable()")
    op.drop_table('job_steps')
    op.drop_table('jobs')
