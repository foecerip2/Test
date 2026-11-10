"""wallets, ledger_reservations, ledger_entries (credits ledger)

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-10 08:10:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0004'
down_revision: Union[str, Sequence[str], None] = '0003'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('wallets',
    sa.Column('organization_id', sa.UUID(), nullable=False),
    sa.Column('balance', sa.BigInteger(), nullable=False),
    sa.Column('held', sa.BigInteger(), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint('balance >= 0', name='ck_wallet_balance_nonneg'),
    sa.CheckConstraint('held >= 0', name='ck_wallet_held_nonneg'),
    sa.CheckConstraint('held <= balance', name='ck_wallet_available_nonneg'),
    sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('organization_id')
    )
    op.create_table('ledger_reservations',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('organization_id', sa.UUID(), nullable=False),
    sa.Column('amount', sa.BigInteger(), nullable=False),
    sa.Column('captured', sa.BigInteger(), nullable=False),
    sa.Column('status', sa.String(length=10), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('settled_at', sa.DateTime(timezone=True), nullable=True),
    sa.CheckConstraint('amount > 0', name='ck_reservation_amount_pos'),
    sa.CheckConstraint("status in ('open','captured','released')", name='ck_reservation_status'),
    sa.CheckConstraint('captured >= 0 and captured <= amount', name='ck_reservation_captured'),
    sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_ledger_reservations_organization_id'), 'ledger_reservations', ['organization_id'], unique=False)
    op.create_index('ix_reservations_open', 'ledger_reservations', ['status', 'created_at'], unique=False)
    op.create_table('ledger_entries',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('organization_id', sa.UUID(), nullable=False),
    sa.Column('kind', sa.String(length=10), nullable=False),
    sa.Column('amount', sa.BigInteger(), nullable=False),
    sa.Column('idempotency_key', sa.String(length=80), nullable=False),
    sa.Column('reservation_id', sa.UUID(), nullable=True),
    sa.Column('actor_user_id', sa.UUID(), nullable=True),
    sa.Column('note', sa.String(length=240), nullable=False),
    sa.Column('model', sa.String(length=64), nullable=True),
    sa.Column('tokens_in', sa.Integer(), nullable=True),
    sa.Column('tokens_out', sa.Integer(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("kind in ('credit','reserve','capture','release','adjustment')", name='ck_ledger_kind'),
    sa.CheckConstraint('amount <> 0', name='ck_ledger_amount_nonzero'),
    sa.CheckConstraint("kind = 'adjustment' or amount > 0", name='ck_ledger_amount_sign'),
    sa.ForeignKeyConstraint(['actor_user_id'], ['users.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['organization_id'], ['organizations.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['reservation_id'], ['ledger_reservations.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('organization_id', 'idempotency_key', name='uq_ledger_idempotency')
    )
    op.create_index('ix_ledger_org_time', 'ledger_entries', ['organization_id', 'created_at'], unique=False)
    # Журнал проводок append-only: UPDATE запрещён. (DELETE разрешён только каскадом от организации — триггер на UPDATE.)
    op.execute("""
        CREATE FUNCTION ledger_entries_immutable() RETURNS trigger AS $$
        BEGIN
            RAISE EXCEPTION 'ledger_entries is append-only';
        END;
        $$ LANGUAGE plpgsql
    """)
    op.execute("""
        CREATE TRIGGER ledger_entries_no_update
        BEFORE UPDATE ON ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_entries_immutable()
    """)


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS ledger_entries_no_update ON ledger_entries")
    op.execute("DROP FUNCTION IF EXISTS ledger_entries_immutable()")
    op.drop_table('ledger_entries')
    op.drop_table('ledger_reservations')
    op.drop_table('wallets')
