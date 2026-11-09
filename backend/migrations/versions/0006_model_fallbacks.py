"""Preserve the current model as primary; add ordered private fallbacks."""

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "model_preferences", sa.Column("revision", sa.BigInteger(), nullable=False, server_default="1")
    )
    op.create_table(
        "model_fallbacks",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(36),
            sa.ForeignKey("model_preferences.user_id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("provider", sa.String(20), nullable=False),
        sa.Column("model", sa.String(120), nullable=False),
        sa.Column("encrypted_key", sa.Text(), nullable=False),
        sa.UniqueConstraint("user_id", "position", name="uq_model_fallback_position"),
    )
    op.create_index("ix_model_fallbacks_user_id", "model_fallbacks", ["user_id"])


def downgrade():
    op.drop_table("model_fallbacks")
    op.drop_column("model_preferences", "revision")
