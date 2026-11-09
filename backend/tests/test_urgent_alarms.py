import json
from pathlib import Path
from unittest.mock import patch

import pytest
from alembic import command
from alembic.config import Config
from cryptography.fernet import Fernet
from sqlalchemy import create_engine, text

from app.auth import password_hash
from app.config import settings


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


def test_urgent_due_time_fallback_cancels_without_changing_user_rules(client, bill_input):
    body = bill_input | {"urgent": True, "rules": []}
    item = client.post("/api/items", json=body).json()
    assert item["rules"] == []
    url = f"/api/items/{item['id']}"
    rows = client.get(url + "/reminders").json()
    assert len(rows) == 1
    assert rows[0]["rule_key"] == "before:0" and rows[0]["fire_at"] == item["due_at"]
    assert rows[0]["status"] == "pending"
    client.post(url + "/state", json={"status": "paid"})
    assert client.get(url + "/reminders").json()[0]["status"] == "cancelled"
    client.post(url + "/state", json={"status": "open"})
    assert client.get(url + "/reminders").json()[0]["status"] == "pending"
    client.put(url, json=body | {"urgent": False})
    assert client.get(url + "/reminders").json()[0]["status"] == "cancelled"
    client.put(url, json=body | {"due_time": "10:00"})
    rows = client.get(url + "/reminders").json()
    assert sum(row["status"] == "pending" for row in rows) == 1
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
    assert len(client.get(f"/api/items/{item['id']}/reminders").json()) == 1


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
