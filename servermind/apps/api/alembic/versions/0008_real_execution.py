"""real execution mode: jobs.mode execute, job_steps.executed/output, execution switches

Revision ID: 0008
Revises: 0007
Create Date: 2026-11-10 11:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0008'
down_revision: Union[str, Sequence[str], None] = '0007'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_constraint('ck_job_mode', 'jobs', type_='check')
    op.create_check_constraint('ck_job_mode', 'jobs', "mode in ('rehearsal','execute')")
    op.create_index('uq_jobs_active_execute_per_server', 'jobs', ['server_id'], unique=True,
                    postgresql_where=sa.text("mode = 'execute' and status in ('queued','running')"))
    op.drop_constraint('ck_job_step_status', 'job_steps', type_='check')
    op.create_check_constraint('ck_job_step_status', 'job_steps', "status in ('rehearsed','executed','blocked','failed','skipped')")
    op.add_column('job_steps', sa.Column('output', sa.Text(), nullable=False, server_default=''))
    op.alter_column('job_steps', 'output', server_default=None)
    op.add_column('organizations', sa.Column('execution_enabled', sa.Boolean(), nullable=False, server_default=sa.text('false')))
    op.add_column('servers', sa.Column('execution_enabled', sa.Boolean(), nullable=False, server_default=sa.text('false')))


def downgrade() -> None:
    op.execute("DELETE FROM jobs WHERE mode = 'execute'")  # каскадно удаляет и шаги
    op.drop_column('servers', 'execution_enabled')
    op.drop_column('organizations', 'execution_enabled')
    op.drop_column('job_steps', 'output')
    op.drop_constraint('ck_job_step_status', 'job_steps', type_='check')
    op.create_check_constraint('ck_job_step_status', 'job_steps', "status in ('rehearsed','blocked','failed','skipped')")
    op.drop_index('uq_jobs_active_execute_per_server', table_name='jobs')
    op.drop_constraint('ck_job_mode', 'jobs', type_='check')
    op.create_check_constraint('ck_job_mode', 'jobs', "mode in ('rehearsal')")
