"""Allow the ChatGPT subscription connection in ai_keys."""

from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("ck_ai_provider", "ai_keys", type_="check")
    op.create_check_constraint("ck_ai_provider", "ai_keys", "provider in ('openai','anthropic','deepseek','chatgpt')")


def downgrade() -> None:
    op.execute("DELETE FROM ai_keys WHERE provider = 'chatgpt'")
    op.drop_constraint("ck_ai_provider", "ai_keys", type_="check")
    op.create_check_constraint("ck_ai_provider", "ai_keys", "provider in ('openai','anthropic','deepseek')")
