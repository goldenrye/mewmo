from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import MetaData, Table, create_engine, inspect, select, text
from sqlalchemy.orm import Session

from app.auth import password_hash, verify_password
from app.config import settings
from app.models import AuthSession, Delivery, Device, Item, ModelPreference, Reminder, User


def test_upgrade_preserves_legacy_data_and_creates_admin(tmp_path, monkeypatch):
    monkeypatch.setattr(settings(), "owner_password_hash", password_hash("legacy-owner-password"))
    monkeypatch.setattr(settings(), "admin_password_hash", "")
    monkeypatch.setattr(settings(), "admin_username", "admin")
    engine = create_engine(f"sqlite:///{tmp_path}/migration.db")
    config = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "migrations"))
    stamp = datetime(2026, 11, 6, tzinfo=UTC)
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, "0001")
        metadata = MetaData()
        tables = {
            name: Table(name, metadata, autoload_with=connection)
            for name in (
                "items",
                "reminders",
                "devices",
                "deliveries",
                "auth_sessions",
            )
        }
        connection.execute(
            tables["items"].insert(),
            {
                "id": "legacy-item",
                "kind": "bill",
                "title": "Legacy bill",
                "payee": "Utility",
                "amount": 120,
                "currency": "USD",
                "due_at": stamp,
                "timezone": "UTC",
                "status": "paid",
                "rules": [],
                "created_at": stamp,
                "updated_at": stamp,
                "finished_at": stamp,
            },
        )
        connection.execute(
            tables["reminders"].insert(),
            {
                "id": "legacy-reminder",
                "item_id": "legacy-item",
                "rule_key": "test",
                "fire_at": stamp,
                "status": "sent",
                "attempts": 1,
                "next_attempt_at": stamp,
                "sent_at": stamp,
            },
        )
        connection.execute(
            tables["devices"].insert(),
            {
                "id": "legacy-device",
                "platform": "ios",
                "endpoint_hash": "a" * 64,
                "subscription": {"token": "a" * 64},
                "active": True,
                "created_at": stamp,
            },
        )
        connection.execute(
            tables["deliveries"].insert(),
            {
                "id": "legacy-delivery",
                "reminder_id": "legacy-reminder",
                "device_id": "legacy-device",
                "status": "sent",
                "attempts": 1,
                "accepted_at": stamp,
            },
        )
        connection.execute(
            tables["auth_sessions"].insert(),
            {
                "token_hash": "old-session",
                "expires_at": stamp + timedelta(days=7),
            },
        )
        command.upgrade(config, "head")
        assert connection.execute(text("PRAGMA foreign_key_check")).all() == []
    with Session(engine) as db:
        admin = db.scalar(select(User))
        assert admin.username == "admin" and admin.is_admin
        assert verify_password("legacy-owner-password", admin.password_hash)
        item = db.get(Item, "legacy-item")
        assert item.user_id == admin.id and item.title == "Legacy bill" and item.status == "paid"
        assert db.get(Device, "legacy-device").user_id == admin.id
        assert not db.get(Device, "legacy-device").active
        assert db.get(Reminder, "legacy-reminder").status == "sent"
        assert db.get(Delivery, "legacy-delivery").device_id == "legacy-device"
        assert db.scalar(select(AuthSession)) is None
        assert db.scalar(select(ModelPreference)) is None
    assert "model_preferences" in inspect(engine).get_table_names()
    for name in ("items", "devices", "auth_sessions"):
        assert (
            next(c for c in inspect(engine).get_columns(name) if c["name"] == "user_id")["nullable"] is False
        )
    # Restarting or rerunning migrations must not reset the account's credentials.
    monkeypatch.setattr(settings(), "owner_password_hash", password_hash("different-env-password"))
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, "head")
        with pytest.raises(RuntimeError, match="cannot be downgraded"):
            command.downgrade(config, "0001")
    with Session(engine) as db:
        assert verify_password("legacy-owner-password", db.scalar(select(User)).password_hash)
    engine.dispose()
