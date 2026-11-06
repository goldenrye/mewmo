from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Delivery, Device, Item, Reminder
from app.push import PushFailure
from app.reminders import dispatch_one, fire_time, notification_payload, reconcile, scan
from app.schemas import ReminderRule, default_rules

NOW = datetime(2026, 11, 6, 16, tzinfo=UTC)


def item(db, kind="bill", due=None, status="open"):
    row = Item(
        user_id="00000000-0000-4000-8000-000000000001",
        kind=kind,
        title="Electricity",
        payee="Utility",
        amount=Decimal("120.50"),
        currency="USD",
        due_at=due or datetime(2026, 11, 20, 17, tzinfo=UTC),
        timezone="America/Los_Angeles",
        status=status,
        rules=[r.model_dump() for r in default_rules(kind)],
    )
    db.add(row)
    db.flush()
    return row


def rows(db, owner):
    db.flush()
    return db.scalars(select(Reminder).where(Reminder.item_id == owner.id).order_by(Reminder.fire_at)).all()


@pytest.mark.parametrize("kind,count", [("bill", 4), ("appointment", 2), ("dated_item", 3)])
def test_default_rows(db, kind, count):
    owner = item(db, kind)
    reconcile(db, owner, NOW)
    reminders = rows(db, owner)
    assert len(reminders) == count
    assert len({r.id for r in reminders}) == count
    assert all(r.status == "pending" for r in reminders)


def test_bill_default_fire_times(db):
    owner = item(db)
    reconcile(db, owner, NOW)
    assert [r.fire_at for r in rows(db, owner)] == [
        datetime(2026, 11, 13, 17, tzinfo=UTC),
        datetime(2026, 11, 19, 17, tzinfo=UTC),
        datetime(2026, 11, 20, 17, tzinfo=UTC),
        datetime(2026, 11, 21, 17, tzinfo=UTC),
    ]


def test_calendar_rule_dst_preserves_local_nine(db):
    owner = item(db, due=datetime(2026, 11, 2, 17, tzinfo=UTC))
    assert fire_time(owner, ReminderRule(mode="day", days=-3)) == datetime(2026, 10, 30, 16, tzinfo=UTC)


def test_skip_past_reminders(db):
    owner = item(db, due=NOW + timedelta(hours=1))
    reconcile(db, owner, NOW)
    assert all(r.fire_at > NOW for r in rows(db, owner))
    assert len(rows(db, owner)) == 2


@pytest.mark.parametrize(
    "kind,state", [("bill", "paid"), ("appointment", "completed"), ("dated_item", "completed")]
)
def test_cancel_and_undo_only_future(db, kind, state):
    owner = item(db, kind)
    reconcile(db, owner, NOW)
    old = rows(db, owner)
    owner.status = state
    reconcile(db, owner, NOW)
    assert all(r.status == "cancelled" for r in old)
    owner.status = "open"
    later = old[0].fire_at + timedelta(seconds=1)
    reconcile(db, owner, later)
    assert old[0].status == "cancelled"
    assert all(r.status == "pending" for r in old[1:])
    assert len(rows(db, owner)) == len(old)


def test_recalculate_and_keep_sent_history(db):
    owner = item(db)
    reconcile(db, owner, NOW)
    old = rows(db, owner)
    old[0].status = "sent"
    old[0].sent_at = NOW
    owner.due_at += timedelta(days=10)
    reconcile(db, owner, NOW)
    assert old[0].status == "sent"
    assert all(r.status == "cancelled" for r in old[1:])
    assert len([r for r in rows(db, owner) if r.status == "pending"]) == 4


def delivery_fixture(db, count=1):
    owner = item(db)
    reminder = Reminder(item_id=owner.id, rule_key="before:60", fire_at=NOW, next_attempt_at=NOW)
    db.add(reminder)
    devices = []
    for index in range(count):
        device = Device(
            user_id=owner.user_id,
            platform="ios",
            endpoint_hash=str(index),
            subscription={"token": "a" * 64},
        )
        db.add(device)
        devices.append(device)
    db.commit()
    return owner, reminder, devices


def test_provider_failure_retries_and_acceptance_marks_sent(db):
    owner, reminder, _ = delivery_fixture(db)
    sent = []

    def failure(*_):
        raise PushFailure("provider_unavailable")

    dispatch_one(db, reminder.id, failure, NOW)
    db.commit()
    assert reminder.status == "failed"
    assert reminder.sent_at is None
    assert reminder.next_attempt_at == NOW + timedelta(seconds=30)
    dispatch_one(db, reminder.id, lambda device, payload: sent.append(payload), NOW + timedelta(seconds=60))
    db.commit()
    assert reminder.status == "sent"
    assert reminder.sent_at is not None
    assert reminder.attempts == 2
    assert len(sent) == 1
    dispatch_one(db, reminder.id, lambda *_: pytest.fail("sent reminder repeated"), NOW + timedelta(hours=1))


def test_partial_delivery_does_not_resend_accepted_device(db):
    _, reminder, devices = delivery_fixture(db, 2)
    calls = []

    def first(device, _):
        calls.append(device.id)
        if device.id == devices[1].id:
            raise PushFailure("temporary")

    dispatch_one(db, reminder.id, first, NOW)
    db.commit()
    assert reminder.status == "failed"
    dispatch_one(db, reminder.id, lambda d, _: calls.append(d.id), NOW + timedelta(minutes=1))
    db.commit()
    assert calls.count(devices[0].id) == 1
    assert calls.count(devices[1].id) == 2
    assert reminder.status == "sent"


def test_no_devices_never_counts_as_sent(db):
    _, reminder, _ = delivery_fixture(db, 0)
    dispatch_one(db, reminder.id, lambda *_: pytest.fail("no device"), NOW)
    assert reminder.status == "failed"
    assert reminder.error == "no_registered_device"


def test_deleted_or_paid_item_cannot_send(db):
    owner, reminder, _ = delivery_fixture(db)
    owner.status = "deleted"
    db.commit()
    dispatch_one(db, reminder.id, lambda *_: pytest.fail("deleted item sent"), NOW)
    assert reminder.status == "cancelled"


def test_revoked_token_disabled(db):
    _, reminder, devices = delivery_fixture(db)

    def revoked(*_):
        raise PushFailure("apns_http_410", permanent=True)

    dispatch_one(db, reminder.id, revoked, NOW)
    assert not devices[0].active
    assert reminder.status != "sent"


def test_notification_hides_amount_even_in_title(db):
    owner, reminder, _ = delivery_fixture(db)
    owner.title = "Electricity USD 120.50"
    payload = notification_payload(owner, reminder)
    assert payload["title"] == "Electricity"
    assert "120" not in payload["title"] + payload["body"]
    assert "amount" not in payload
    assert "09:00" in payload["body"]
    assert payload["reminder_id"] == reminder.id


def test_worker_scans_due_rows(db):
    _, reminder, _ = delivery_fixture(db)
    accepted = []
    bind = db.get_bind()
    scan(lambda: Session(bind), lambda d, p: accepted.append(p), NOW + timedelta(seconds=59))
    db.expire_all()
    assert reminder.status == "sent"
    assert len(accepted) == 1
    assert db.scalar(select(Delivery)).status == "sent"
