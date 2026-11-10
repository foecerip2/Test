"""platform_models (AI-модели платформы, подключаются админом)

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-10 08:40:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0006'
down_revision: Union[str, Sequence[str], None] = '0005'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('platform_models',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('provider', sa.String(length=16), nullable=False),
    sa.Column('model', sa.String(length=64), nullable=False),
    sa.Column('key_enc', sa.LargeBinary(), nullable=False),
    sa.Column('masked', sa.String(length=32), nullable=False),
    sa.Column('status', sa.String(length=10), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('price_in_per_1k', sa.Integer(), nullable=False),
    sa.Column('price_out_per_1k', sa.Integer(), nullable=False),
    sa.Column('price_list_version', sa.String(length=40), nullable=False),
    sa.Column('created_by', sa.UUID(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("provider in ('openai','anthropic','deepseek')", name='ck_platform_provider'),
    sa.CheckConstraint("status in ('valid','unchecked','invalid')", name='ck_platform_status'),
    sa.CheckConstraint('price_in_per_1k > 0 and price_out_per_1k > 0', name='ck_platform_prices'),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('provider', 'model', name='uq_platform_model')
    )
    op.create_index('uq_platform_model_active', 'platform_models', ['active'], unique=True, postgresql_where=sa.text('active'))


def downgrade() -> None:
    op.drop_table('platform_models')
