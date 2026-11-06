"""Initial Mewmo schema, independent of rental-mgmt."""

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "items",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("title", sa.String(180), nullable=False),
        sa.Column("payee", sa.String(180)),
        sa.Column("amount", sa.Numeric(14, 2)),
        sa.Column("currency", sa.String(3)),
        sa.Column("account_last4", sa.String(4)),
        sa.Column("due_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("timezone", sa.String(80), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("rules", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.CheckConstraint("kind IN ('bill','appointment','dated_item')", name="ck_item_kind"),
        sa.CheckConstraint("status IN ('open','paid','completed','deleted')", name="ck_item_status"),
        sa.CheckConstraint("amount IS NULL OR amount >= 0", name="ck_item_amount"),
    )
    op.create_index("ix_items_status_due", "items", ["status", "due_at"])
    op.create_table(
        "reminders",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("item_id", sa.String(36), sa.ForeignKey("items.id", ondelete="CASCADE"), nullable=False),
        sa.Column("rule_key", sa.String(100), nullable=False),
        sa.Column("fire_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True)),
        sa.Column("error", sa.String(160)),
        sa.UniqueConstraint("item_id", "rule_key", "fire_at", name="uq_reminder_schedule"),
    )
    op.create_index("ix_reminders_dispatch", "reminders", ["status", "next_attempt_at"])
    op.create_table(
        "devices",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("platform", sa.String(12), nullable=False),
        sa.Column("endpoint_hash", sa.String(64), unique=True, nullable=False),
        sa.Column("subscription", sa.JSON(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "deliveries",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "reminder_id", sa.String(36), sa.ForeignKey("reminders.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column(
            "device_id", sa.String(36), sa.ForeignKey("devices.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("accepted_at", sa.DateTime(timezone=True)),
        sa.Column("error", sa.String(160)),
        sa.UniqueConstraint("reminder_id", "device_id", name="uq_delivery_target"),
    )
    op.create_table(
        "auth_sessions",
        sa.Column("token_hash", sa.String(64), primary_key=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade():
    for table in ("auth_sessions", "deliveries", "devices", "reminders", "items"):
        op.drop_table(table)
