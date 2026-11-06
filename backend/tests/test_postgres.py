"""Opt-in real PostgreSQL tests, isolated in a fresh schema per test."""

import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, select, text
from sqlalchemy.orm import Session

from app.models import Device, Item, Reminder
from app.reminders import dispatch_one, reconcile

URL = os.getenv("TEST_POSTGRES_URL", "")
pytestmark = pytest.mark.skipif(not URL, reason="Set TEST_POSTGRES_URL to a dedicated test database")
NOW = datetime(2026, 11, 6, 9, tzinfo=UTC)


@pytest.fixture
def postgres():
    schema = "mewmo_test_" + uuid.uuid4().hex
    root = create_engine(URL)
    with root.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    isolated = create_engine(URL, connect_args={"options": f"-csearch_path={schema}"})
    config = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "migrations"))
    with isolated.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, "head")
    try:
        yield isolated
    finally:
        isolated.dispose()
        with root.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        root.dispose()


def seed(engine):
    with Session(engine) as db, db.begin():
        item = Item(
            kind="bill",
            title="Utility",
            payee="Provider",
            amount=120,
            currency="USD",
            due_at=NOW,
            timezone="UTC",
            status="open",
            rules=[],
        )
        db.add(item)
        db.flush()
        reminder = Reminder(item_id=item.id, rule_key="day:0:09:00", fire_at=NOW, next_attempt_at=NOW)
        db.add(reminder)
        db.add(Device(platform="ios", endpoint_hash="abc", subscription={"token": "a" * 64}))
        db.flush()
        return item.id, reminder.id


def test_alembic_creates_postgres_schema(postgres):
    assert set(inspect(postgres).get_table_names()) == {
        "alembic_version",
        "items",
        "reminders",
        "devices",
        "deliveries",
        "auth_sessions",
    }
    item_id, _ = seed(postgres)
    with Session(postgres) as db:
        assert db.get(Item, item_id).due_at == NOW
        assert db.get(Item, item_id).amount == 120


def test_two_workers_cannot_send_same_row(postgres):
    _, reminder_id = seed(postgres)
    barrier = threading.Barrier(2)
    calls = []

    def worker():
        with Session(postgres) as db, db.begin():
            # Deliberately prime each identity map with the unsent state before locking.
            db.get(Reminder, reminder_id)
            barrier.wait(timeout=5)
            dispatch_one(db, reminder_id, lambda *_: calls.append("accepted"), NOW)

    with ThreadPoolExecutor(max_workers=2) as pool:
        first, second = pool.submit(worker), pool.submit(worker)
        first.result(timeout=10)
        second.result(timeout=10)
    assert calls == ["accepted"]
    with Session(postgres) as db:
        assert db.get(Reminder, reminder_id).status == "sent"


def test_payment_commit_cancels_waiting_worker(postgres):
    item_id, reminder_id = seed(postgres)
    ready = threading.Event()

    def worker():
        with Session(postgres) as db, db.begin():
            ready.set()
            dispatch_one(db, reminder_id, lambda *_: pytest.fail("paid reminder was sent"), NOW)

    with ThreadPoolExecutor(max_workers=1) as pool:
        with Session(postgres) as db, db.begin():
            item = db.scalar(select(Item).where(Item.id == item_id).with_for_update())
            future = pool.submit(worker)
            assert ready.wait(timeout=5)
            item.status = "paid"
            reconcile(db, item, NOW)
        future.result(timeout=10)
    with Session(postgres) as db:
        assert db.get(Reminder, reminder_id).status == "cancelled"
