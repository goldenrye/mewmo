import uuid
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import JSON, DateTime, ForeignKey, Index, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import TypeDecorator


def now() -> datetime:
    return datetime.now(UTC)


def new_id() -> str:
    return str(uuid.uuid4())


class UTCDateTime(TypeDecorator):
    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is not None:
            if value.tzinfo is None:
                raise ValueError("Timezone-aware datetime required")
            return value.astimezone(UTC)
        return value

    def process_result_value(self, value, dialect):
        if value is not None:
            return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
        return value


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    username: Mapped[str] = mapped_column(String(40), unique=True)
    display_name: Mapped[str] = mapped_column(String(80))
    password_hash: Mapped[str] = mapped_column(String(256))
    is_admin: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=now)


class Invitation(Base):
    __tablename__ = "invitations"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=now)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime)
    used_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    used_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    revoked_at: Mapped[datetime | None] = mapped_column(UTCDateTime)


class ModelPreference(Base):
    __tablename__ = "model_preferences"
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    provider: Mapped[str] = mapped_column(String(20))
    model: Mapped[str] = mapped_column(String(120))
    encrypted_key: Mapped[str] = mapped_column(Text)
    enabled: Mapped[bool] = mapped_column(default=False)
    allow_images: Mapped[bool] = mapped_column(default=False)


class Item(Base):
    __tablename__ = "items"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    kind: Mapped[str] = mapped_column(String(20))
    title: Mapped[str] = mapped_column(String(180))
    payee: Mapped[str | None] = mapped_column(String(180))
    amount: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    currency: Mapped[str | None] = mapped_column(String(3))
    account_last4: Mapped[str | None] = mapped_column(String(4))
    due_at: Mapped[datetime] = mapped_column(UTCDateTime)
    timezone: Mapped[str] = mapped_column(String(80))
    status: Mapped[str] = mapped_column(String(20), default="open")
    rules: Mapped[list] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=now, onupdate=now)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    __table_args__ = (Index("ix_items_status_due", "status", "due_at"),)


class Reminder(Base):
    __tablename__ = "reminders"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    item_id: Mapped[str] = mapped_column(ForeignKey("items.id", ondelete="CASCADE"))
    rule_key: Mapped[str] = mapped_column(String(100))
    fire_at: Mapped[datetime] = mapped_column(UTCDateTime)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    attempts: Mapped[int] = mapped_column(default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(UTCDateTime)
    sent_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    error: Mapped[str | None] = mapped_column(String(160))
    __table_args__ = (
        UniqueConstraint("item_id", "rule_key", "fire_at", name="uq_reminder_schedule"),
        Index("ix_reminders_dispatch", "status", "next_attempt_at"),
    )


class Device(Base):
    __tablename__ = "devices"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    platform: Mapped[str] = mapped_column(String(12))
    endpoint_hash: Mapped[str | None] = mapped_column(String(64), unique=True)
    client_key_hash: Mapped[str | None] = mapped_column(String(64), index=True)
    subscription: Mapped[dict] = mapped_column(JSON)
    active: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=now)


class Delivery(Base):
    __tablename__ = "deliveries"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    reminder_id: Mapped[str] = mapped_column(ForeignKey("reminders.id", ondelete="CASCADE"))
    device_id: Mapped[str] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"))
    status: Mapped[str] = mapped_column(String(20), default="pending")
    attempts: Mapped[int] = mapped_column(default=0)
    accepted_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    error: Mapped[str | None] = mapped_column(String(160))
    __table_args__ = (UniqueConstraint("reminder_id", "device_id", name="uq_delivery_target"),)


class AuthSession(Base):
    __tablename__ = "auth_sessions"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime)
