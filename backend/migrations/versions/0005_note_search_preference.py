"""Keep existing accounts local until they enable AI note search in settings."""

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "model_preferences",
        sa.Column("allow_note_search", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade():
    op.drop_column("model_preferences", "allow_note_search")
