"""Urgent alarms are an explicit, default-off item preference."""

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("items", sa.Column("urgent", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade():
    op.drop_column("items", "urgent")
