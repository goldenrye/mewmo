import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

import pytest
from alembic import command
from alembic.config import Config
from cryptography.fernet import Fernet
from sqlalchemy import create_engine, select, text

from app.auth import password_hash
from app.config import settings
from app.models import Reminder
from app.reminders import urgent_rules


def test_urgency_defaults_off_and_old_edits_preserve_explicit_opt_in(client, bill_input):
    ordinary = client.post("/api/items", json=bill_input).json()
    assert ordinary["urgent"] is False
    saved = client.post("/api/items", json=bill_input | {"urgent": True}).json()
    assert saved["urgent"] is True
    changed = client.put(f"/api/items/{saved['id']}", json=bill_input | {"title": "Updated"})
    assert changed.status_code == 200 and changed.json()["urgent"] is True
    disabled = client.put(f"/api/items/{saved['id']}", json=bill_input | {"urgent": False})
    assert disabled.json()["urgent"] is False


@pytest.mark.parametrize("value", ["true", 1, None, {}, []])
def test_urgency_requires_a_boolean(client, bill_input, value):
    assert client.post("/api/items", json=bill_input | {"urgent": value}).status_code == 422


def test_urgent_automatic_rules_cancel_and_reschedule_together(client, bill_input):
    body = bill_input | {"urgent": True, "rules": []}
    item = client.post("/api/items", json=body).json()
    assert [rule["minutes"] for rule in item["rules"]] == [10080, 1440, 60, 0]
    url = f"/api/items/{item['id']}"
    rows = client.get(url + "/reminders").json()
    assert len(rows) == 4
    assert [row for row in rows if row["rule_key"] == "before:0"][0]["fire_at"] == item["due_at"]
    assert all(row["status"] == "pending" for row in rows)
    client.post(url + "/state", json={"status": "paid"})
    assert all(row["status"] == "cancelled" for row in client.get(url + "/reminders").json())
    client.post(url + "/state", json={"status": "open"})
    assert all(row["status"] == "pending" for row in client.get(url + "/reminders").json())
    client.put(url, json=body | {"urgent": False})
    assert all(row["status"] == "cancelled" for row in client.get(url + "/reminders").json())
    client.put(url, json=body | {"due_time": "10:00"})
    rows = client.get(url + "/reminders").json()
    assert sum(row["status"] == "pending" for row in rows) == 4
    client.delete(url)
    assert client.get(url + "/reminders").status_code == 404


@pytest.mark.parametrize(
    "rule",
    [
        {"mode": "before", "minutes": 0},
        {"mode": "day", "days": 0, "at": "09:00"},
    ],
)
def test_urgent_fallback_does_not_duplicate_existing_due_time_rule(client, bill_input, rule):
    item = client.post("/api/items", json=bill_input | {"urgent": True, "rules": [rule]}).json()
    rows = client.get(f"/api/items/{item['id']}/reminders").json()
    assert len(rows) == 4
    assert sum(row["fire_at"] == item["due_at"] for row in rows) == 1


def test_past_urgent_item_does_not_create_a_late_push(client, bill_input):
    item = client.post(
        "/api/items",
        json=bill_input
        | {
            "urgent": True,
            "rules": [],
            "due_date": "2000-01-01",
        },
    ).json()
    assert client.get(f"/api/items/{item['id']}/reminders").json() == []


def test_alarm_title_uses_the_same_amount_redaction_as_notifications(client, bill_input):
    item = client.post(
        "/api/items",
        json=bill_input
        | {
            "urgent": True,
            "title": "Electricity $120.50 and 120.50",
        },
    ).json()
    assert "120.50" not in item["alarm_title"]
    assert "Electricity" in item["alarm_title"]
    assert "120.50" in item["title"]


def test_parsing_and_ai_cannot_enable_urgency(client, monkeypatch):
    body = {
        "text": "Urgently turn off gas in 5 minutes",
        "local_date": "2026-11-09",
        "timezone": "Asia/Shanghai",
        "client_now": "2026-11-09T13:33:00+08:00",
        "urgent": True,
    }
    assert client.post("/api/drafts/text", json=body).json()["urgent"] is False
    monkeypatch.setattr(settings(), "llm_encryption_key", Fernet.generate_key().decode())
    client.put(
        "/api/model-settings",
        json={
            "provider": "openai",
            "model": "test",
            "api_key": "test-only",
            "enabled": True,
        },
    )
    with patch(
        "app.ai_assistance.request_model",
        return_value=json.dumps(
            {
                "kind": "dated_item",
                "title": "Turn off gas",
                "urgent": True,
                "due_date": "2026-11-09",
                "due_time": "13:38",
            }
        ),
    ):
        response = client.post("/api/drafts/text", json=body)
    assert response.status_code == 200 and response.json()["urgent"] is False


def test_urgent_migration_preserves_items_and_defaults_existing_rows_off(tmp_path, monkeypatch):
    monkeypatch.setattr(settings(), "admin_password_hash", password_hash("test-password-long"))
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "migrations"))
    engine = create_engine(f"sqlite:///{tmp_path}/urgent.db")
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, "0006")
        owner = connection.scalar(text("SELECT id FROM users LIMIT 1"))
        connection.execute(
            text(
                "INSERT INTO items (id,user_id,kind,title,due_at,timezone,status,rules,created_at,updated_at) "
                "VALUES ('existing',:owner,'dated_item','Keep me','2099-11-09 05:38:00','Asia/Shanghai',"
                "'open','[]','2026-11-09 00:00:00','2026-11-09 00:00:00')"
            ),
            {"owner": owner},
        )
        command.upgrade(config, "head")
        row = connection.execute(text("SELECT title,urgent FROM items WHERE id='existing'")).one()
        assert row.title == "Keep me" and not row.urgent
        command.downgrade(config, "0006")
        assert connection.scalar(text("SELECT title FROM items WHERE id='existing'")) == "Keep me"
    engine.dispose()


@pytest.mark.parametrize(
    "seconds,offsets",
    [
        (10 * 86400 + 1, [10080, 1440, 60, 0]),
        (10 * 86400, [1440, 60, 0]),
        (3 * 86400, [1440, 60, 0]),
        (3 * 86400 - 1, [60, 0]),
        (3600, [60, 0]),
        (300, [60, 0]),
    ],
)
def test_smart_urgent_exact_boundaries(seconds, offsets):
    at = datetime(2026, 11, 15, 9, tzinfo=UTC)
    assert [rule.minutes for rule in urgent_rules(at + timedelta(seconds=seconds), at)] == offsets


@pytest.mark.parametrize(
    "minutes,offsets",
    [
        (11 * 1440, [10080, 1440, 60, 0]),
        (10 * 1440, [1440, 60, 0]),
        (3 * 1440, [1440, 60, 0]),
        (3 * 1440 - 1, [60, 0]),
        (61, [60, 0]),
        (60, [0]),
        (5, [0]),
        (-5, []),
    ],
)
def test_confirmed_schedule_uses_server_time_and_skips_past_alerts(client, bill_input, minutes, offsets):
    at = datetime(2026, 11, 15, 9, tzinfo=UTC)
    due = at + timedelta(minutes=minutes)
    with patch("app.main.now", return_value=at), patch("app.reminders.now", return_value=at):
        result = client.post(
            "/api/items",
            json=bill_input
            | {
                "urgent": True,
                "timezone": "UTC",
                "due_date": due.date().isoformat(),
                "due_time": due.strftime("%H:%M"),
                "rules": [],
            },
        )
    assert result.status_code == 201
    item = result.json()
    rows = client.get(f"/api/items/{item['id']}/reminders").json()
    assert {row["rule_key"] for row in rows} == {f"before:{offset}" for offset in offsets}
    for row in rows:
        offset = int(row["rule_key"].split(":")[1])
        assert datetime.fromisoformat(row["fire_at"].replace("Z", "+00:00")) == due - timedelta(
            minutes=offset
        )


def test_tier_is_frozen_on_undo_but_recomputed_on_save_and_ids_stay_stable(client, bill_input):
    at = datetime(2026, 11, 15, 9, tzinfo=UTC)
    body = bill_input | {"urgent": True, "timezone": "UTC", "due_date": "2026-11-26", "due_time": "09:00"}
    with patch("app.main.now", return_value=at), patch("app.reminders.now", return_value=at):
        item = client.post("/api/items", json=body).json()
    assert item["early_alarm_id"] != item["id"]
    url = f"/api/items/{item['id']}"
    with (
        patch("app.main.now", return_value=at + timedelta(days=2)),
        patch("app.reminders.now", return_value=at + timedelta(days=2)),
    ):
        client.post(url + "/state", json={"status": "paid"})
        undone = client.post(url + "/state", json={"status": "open"}).json()
        assert undone["rules"] == item["rules"]
        assert len([r for r in client.get(url + "/reminders").json() if r["status"] == "pending"]) == 4
        changed = client.put(url, json=body | {"title": "Updated"}).json()
        assert [r["minutes"] for r in changed["rules"]] == [1440, 60, 0]
        assert changed["early_alarm_id"] == item["early_alarm_id"]
        client.put(url, json=body | {"due_date": "2026-11-28"})
        assert client.get(url).json()["early_alarm_id"] == item["early_alarm_id"]
        disabled = client.put(
            url, json=body | {"urgent": False, "rules": client.get(url).json()["rules"]}
        ).json()
        assert any(r["mode"] == "day" for r in disabled["rules"])
        assert disabled["early_alarm_id"] == item["early_alarm_id"]


@pytest.mark.parametrize("day", ["2026-11-01", "2027-03-14"])
def test_urgent_offsets_are_elapsed_time_across_dst(client, bill_input, day):
    due = (
        datetime.fromisoformat(day + "T03:30:00").replace(tzinfo=ZoneInfo("America/New_York")).astimezone(UTC)
    )
    at = due - timedelta(days=12)
    with patch("app.main.now", return_value=at), patch("app.reminders.now", return_value=at):
        response = client.post(
            "/api/items",
            json=bill_input
            | {
                "urgent": True,
                "timezone": "America/New_York",
                "due_date": day,
                "due_time": "03:30",
            },
        )
    assert response.status_code == 201
    rows = client.get(f"/api/items/{response.json()['id']}/reminders").json()
    assert len(rows) == 4
    for row in rows:
        fire = datetime.fromisoformat(row["fire_at"].replace("Z", "+00:00"))
        assert due - fire == timedelta(minutes=int(row["rule_key"].split(":")[1]))


def test_reselecting_a_tier_preserves_sent_reminder_history(client, db, bill_input):
    at = datetime(2026, 11, 15, 9, tzinfo=UTC)
    body = bill_input | {"urgent": True, "timezone": "UTC", "due_date": "2026-11-26", "due_time": "09:00"}
    with patch("app.main.now", return_value=at), patch("app.reminders.now", return_value=at):
        item = client.post("/api/items", json=body).json()
    sent = db.scalar(
        select(Reminder).where(Reminder.item_id == item["id"], Reminder.rule_key == "before:10080")
    )
    sent.status, sent.sent_at = "sent", at + timedelta(days=4)
    db.commit()
    with (
        patch("app.main.now", return_value=at + timedelta(days=5)),
        patch("app.reminders.now", return_value=at + timedelta(days=5)),
    ):
        client.put(f"/api/items/{item['id']}", json=body | {"title": "Updated"})
    rows = client.get(f"/api/items/{item['id']}/reminders").json()
    assert len(rows) == 4
    assert [r["id"] for r in rows if r["status"] == "sent"] == [sent.id]
    assert {r["rule_key"] for r in rows if r["status"] == "pending"} == {
        "before:1440",
        "before:60",
        "before:0",
    }
