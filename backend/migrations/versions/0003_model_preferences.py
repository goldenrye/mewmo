"""Optional per-user AI credentials and consent; existing accounts remain local-only."""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "model_preferences",
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("provider", sa.String(20), nullable=False),
        sa.Column("model", sa.String(120), nullable=False),
        sa.Column("encrypted_key", sa.Text(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("allow_images", sa.Boolean(), nullable=False),
    )


def downgrade():
    op.drop_table("model_preferences")
