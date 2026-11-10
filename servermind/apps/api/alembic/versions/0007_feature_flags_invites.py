"""feature_flags and invites (admin panel)

Revision ID: 0007
Revises: 0006
Create Date: 2026-11-10 10:30:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0007'
down_revision: Union[str, Sequence[str], None] = '0006'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('feature_flags',
    sa.Column('key', sa.String(length=40), nullable=False),
    sa.Column('enabled', sa.Boolean(), nullable=False),
    sa.Column('updated_by', sa.UUID(), nullable=True),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['updated_by'], ['users.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('key')
    )
    op.create_table('invites',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('code', sa.String(length=40), nullable=False),
    sa.Column('created_by', sa.UUID(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('used_by', sa.UUID(), nullable=True),
    sa.Column('used_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['used_by'], ['users.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('code', name='uq_invite_code')
    )


def downgrade() -> None:
    op.drop_table('invites')
    op.drop_table('feature_flags')
