"""Private accounts and seven-day invitations; preserve legacy owner data."""

import re
from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op

from app.config import settings

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None
ADMIN_ID = "00000000-0000-4000-8000-000000000001"


def upgrade():
    config = settings()
    username = config.admin_username.strip().lower()
    password = config.admin_password_hash or config.owner_password_hash
    if not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{2,39}", username):
        raise RuntimeError(
            "ADMIN_USERNAME must be 3-40 lowercase letters, digits, dots, dashes or underscores"
        )
    if not re.fullmatch(r"scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}", password):
        raise RuntimeError("Set ADMIN_PASSWORD_HASH (or legacy OWNER_PASSWORD_HASH) before migrating")
    users = op.create_table(
        "users",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("username", sa.String(40), nullable=False, unique=True),
        sa.Column("display_name", sa.String(80), nullable=False),
        sa.Column("password_hash", sa.String(256), nullable=False),
        sa.Column("is_admin", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.bulk_insert(
        users,
        [
            {
                "id": ADMIN_ID,
                "username": username,
                "display_name": "Administrator",
                "password_hash": password,
                "is_admin": True,
                "created_at": datetime.now(UTC),
            }
        ],
    )
    # Password-only clients and their sessions must not survive the ownership upgrade.
    op.execute(sa.text("DELETE FROM auth_sessions"))
    for table in ("items", "devices", "auth_sessions"):
        op.add_column(table, sa.Column("user_id", sa.String(36), nullable=True))
        op.execute(sa.text(f"UPDATE {table} SET user_id = :owner").bindparams(owner=ADMIN_ID))
        with op.batch_alter_table(table) as batch:
            batch.alter_column("user_id", existing_type=sa.String(36), nullable=False)
            batch.create_foreign_key(f"fk_{table}_user_id", "users", ["user_id"], ["id"])
            batch.create_index(f"ix_{table}_user_id", ["user_id"])
    with op.batch_alter_table("devices") as batch:
        batch.alter_column("endpoint_hash", existing_type=sa.String(64), nullable=True)
        batch.add_column(sa.Column("client_key_hash", sa.String(64), nullable=True))
        batch.create_index("ix_devices_client_key_hash", ["client_key_hash"])
    # Legacy devices have no installation binding. Re-enable them after signing in.
    op.execute(sa.text("UPDATE devices SET active = false"))
    op.create_table(
        "invitations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("created_by", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_by", sa.String(36), sa.ForeignKey("users.id")),
        sa.Column("used_at", sa.DateTime(timezone=True)),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
    )


def downgrade():
    # Flattening multiple private accounts would disclose their data to one owner.
    raise RuntimeError("Account migration cannot be downgraded. Restore a pre-upgrade backup instead.")
