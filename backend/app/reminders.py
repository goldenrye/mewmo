import logging
import re
from datetime import UTC, datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Delivery, Device, Item, Reminder, now
from .schemas import ReminderRule

log = logging.getLogger(__name__)


def fire_time(item: Item, rule: ReminderRule) -> datetime:
    if rule.mode == "before":
        return item.due_at - timedelta(minutes=rule.minutes)
    zone = ZoneInfo(item.timezone)
    local_day = item.due_at.astimezone(zone).date() + timedelta(days=rule.days)
    # Calendar-day reminders preserve wall-clock time over DST. For a missing
    # wall time the round trip moves forward; repeated times use the first fold.
    local = datetime.combine(local_day, time.fromisoformat(rule.at), zone)
    return local.astimezone(UTC)


def reconcile(db: Session, item: Item, at: datetime | None = None):
    at = at or now()
    existing = db.scalars(select(Reminder).where(Reminder.item_id == item.id)).all()
    by_key = {(r.rule_key, r.fire_at): r for r in existing}
    for row in existing:
        if row.status != "sent":
            row.status = "cancelled"
            row.error = None
    if item.status != "open":
        return
    for raw in item.rules:
        rule = ReminderRule.model_validate(raw)
        fire = fire_time(item, rule)
        if fire <= at:
            continue
        row = by_key.get((rule.key(), fire))
        if row is None:
            db.add(Reminder(item_id=item.id, rule_key=rule.key(), fire_at=fire, next_attempt_at=fire))
        elif row.status != "sent":
            row.status = "pending"
            row.next_attempt_at = fire
            row.error = None


def notification_payload(item: Item, reminder: Reminder) -> dict:
    local = item.due_at.astimezone(ZoneInfo(item.timezone))
    # Amount and account fields deliberately never enter the push payload.
    from .parsing import MONEY

    title = MONEY.sub("", item.title)
    if item.amount is not None:
        # Also remove a bare amount if the owner typed it into the title.
        title = re.sub(
            r"\d[\d,]*(?:\.\d+)?",
            lambda m: "" if Decimal(m[0].replace(",", "")) == item.amount else m[0],
            title,
        )
    title = re.sub(r"\s+", " ", title).strip() or "Your bill reminder"
    return {
        "title": title,
        "body": local.strftime("%A, %Y-%m-%d at %H:%M") + f" ({item.timezone})",
        "item_id": item.id,
        "reminder_id": reminder.id,
    }


def dispatch_one(db: Session, reminder_id: str, sender, at: datetime | None = None):
    at = at or now()
    reference = db.get(Reminder, reminder_id)
    if not reference:
        return
    # Mutations acquire this same item lock. Completion/delete cannot commit
    # between our state check and a provider accepting an in-flight push.
    item = db.scalar(select(Item).where(Item.id == reference.item_id).with_for_update())
    row = db.scalar(
        select(Reminder)
        .where(Reminder.id == reminder_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if not item or not row or row.status not in ("pending", "failed") or row.next_attempt_at > at:
        return
    if item.status != "open":
        row.status = "cancelled"
        return
    # The device lock also serializes logout and endpoint reassignment with sends.
    devices = db.scalars(
        select(Device)
        .where(Device.user_id == item.user_id, Device.active.is_(True))
        .order_by(Device.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).all()
    row.attempts += 1
    accepted = (
        db.scalar(
            select(Delivery.id)
            .join(Device, Device.id == Delivery.device_id)
            .where(
                Delivery.reminder_id == row.id,
                Delivery.status == "sent",
                Device.user_id == item.user_id,
            )
            .limit(1)
        )
        is not None
    )
    unresolved = False
    for device in devices:
        delivery = db.scalar(
            select(Delivery).where(Delivery.reminder_id == row.id, Delivery.device_id == device.id)
        )
        if not delivery:
            delivery = Delivery(reminder_id=row.id, device_id=device.id)
            db.add(delivery)
            db.flush()
        if delivery.status == "sent":
            accepted = True
            continue
        delivery.attempts += 1
        try:
            sender(device, notification_payload(item, row))
            delivery.status, delivery.accepted_at, delivery.error = "sent", at, None
            accepted = True
        except Exception as error:
            # Provider responses may contain tokens. Store only our allowlisted codes.
            from .push import PushFailure

            code = error.code if isinstance(error, PushFailure) else "provider_unavailable"
            delivery.status, delivery.error = "failed", code
            if isinstance(error, PushFailure) and error.permanent:
                device.active = False
            else:
                unresolved = True
    if accepted and not unresolved:
        row.status, row.sent_at, row.error = "sent", at, None
    else:
        row.status = "failed"
        row.error = "delivery_failed" if devices else "no_registered_device"
        row.next_attempt_at = at + timedelta(seconds=min(300, 30 * 2 ** min(row.attempts - 1, 4)))


def scan(db_factory, sender, at: datetime | None = None):
    at = at or now()
    with db_factory() as db:
        ids = db.scalars(
            select(Reminder.id)
            .where(Reminder.status.in_(["pending", "failed"]), Reminder.next_attempt_at <= at)
            .order_by(Reminder.next_attempt_at)
            .limit(200)
        ).all()
    for reminder_id in ids:
        try:
            with db_factory() as db, db.begin():
                dispatch_one(db, reminder_id, sender, at)
        except Exception:
            log.error("Reminder transaction failed; it will be retried")
