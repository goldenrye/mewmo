import json
from datetime import UTC, datetime, timedelta
from unittest.mock import patch
from zoneinfo import ZoneInfo

import pytest
from cryptography.fernet import Fernet
from pydantic import ValidationError
from sqlalchemy import func, select

from app.config import settings
from app.models import Device, Item, Reminder
from app.parsing import parse_text
from app.reminders import dispatch_one
from app.schemas import ParseRequest, default_rules


def context(text, now="2026-11-09T13:33:00+08:00", zone="Asia/Shanghai"):
    instant = datetime.fromisoformat(now)
    return ParseRequest(
        text=text, client_now=instant, local_date=instant.astimezone(ZoneInfo(zone)).date(), timezone=zone
    )


@pytest.mark.parametrize(
    "text,clock",
    [
        ("增加一个5分钟后的测试提示", "13:38"),
        ("提醒我五分钟后喝水", "13:38"),
        ("Remind me in 5 minutes to test notifications", "13:38"),
        ("Add a notification 5 minutes later", "13:38"),
        ("After 5 mins remind me", "13:38"),
        ("Test 5 minutes from now", "13:38"),
        ("十分钟后喝水", "13:43"),
        ("二十五分钟后喝水", "13:58"),
        ("半小时后开会", "14:03"),
        ("一个小时后喝水", "14:33"),
        ("2小时后开会", "15:33"),
        ("In 1.5 hours meeting", "15:03"),
        ("in 5 minutes appointment", "13:38"),
    ],
)
def test_countdown_resolves_client_time_and_schedules_at_that_time(text, clock):
    draft = parse_text(context(text))
    assert draft.due_date.isoformat() == "2026-11-09"
    assert draft.due_time == clock
    assert "due_time" not in draft.uncertain and "due_date" not in draft.uncertain
    assert [rule.key() for rule in draft.rules] == ["before:0"]


@pytest.mark.parametrize(
    "now,zone,day,clock",
    [
        ("2026-11-09T23:58:00+08:00", "Asia/Shanghai", "2026-11-10", "00:03"),
        ("2026-12-31T23:58:00+08:00", "Asia/Shanghai", "2027-01-01", "00:03"),
        ("2026-11-09T13:33:42+08:00", "Asia/Shanghai", "2026-11-09", "13:39"),
        ("2026-11-09T05:33:00+00:00", "Asia/Shanghai", "2026-11-09", "13:38"),
        ("2026-03-08T01:58:00-08:00", "America/Los_Angeles", "2026-03-08", "03:03"),
    ],
)
def test_midnight_rounding_and_dst(now, zone, day, clock):
    draft = parse_text(context("in 5 minutes test", now, zone))
    assert (str(draft.due_date), draft.due_time) == (day, clock)


@pytest.mark.parametrize(
    "text",
    [
        "in 0 minutes",
        "in -5 minutes",
        "0分钟后",
        "-5分钟后",
        "in 525601 minutes",
        "in 5 minutes or in 10 minutes",
        "in 1 hour 30 minutes",
        "1小时5分钟后",
        "in 5 minutes at 09:00",
        "明天5分钟后提醒我",
    ],
)
def test_ambiguous_or_invalid_countdown_never_becomes_0900(text):
    draft = parse_text(context(text))
    assert draft.due_time is None and draft.due_date is None
    assert draft.warnings


def test_dst_fold_is_not_silently_shifted():
    draft = parse_text(context("in 5 minutes", "2026-11-01T00:58:00-07:00", "America/Los_Angeles"))
    assert draft.due_time is None and draft.due_date is None
    assert "occurs twice" in draft.warnings[0]


def test_clock_requires_offset_and_matching_local_date():
    for value in ("2026-11-09T13:33:00", "2026-11-10T13:33:00+08:00"):
        with pytest.raises(ValidationError):
            ParseRequest(
                text="in 5 minutes", local_date="2026-11-09", timezone="Asia/Shanghai", client_now=value
            )


@pytest.mark.parametrize("enabled", [False, True])
@pytest.mark.parametrize("kind", ["dated_item", "appointment"])
def test_ai_cannot_replace_computed_time_or_countdown_rule(client, db, monkeypatch, enabled, kind):
    monkeypatch.setattr(settings(), "llm_encryption_key", Fernet.generate_key().decode())
    assert (
        client.put(
            "/api/model-settings",
            json={
                "provider": "openai",
                "model": "test",
                "api_key": "test-key",
                "enabled": enabled,
            },
        ).status_code
        == 200
    )
    with patch(
        "app.ai_assistance.request_model",
        return_value=json.dumps(
            {
                "kind": kind,
                "title": "Test",
                "due_date": "2026-11-10",
                "due_time": "09:00",
            }
        ),
    ) as model:
        response = client.post(
            "/api/drafts/text", json=context("增加一个5分钟后的测试提示").model_dump(mode="json")
        )
    assert response.status_code == 200
    draft = response.json()
    assert draft["due_date"] == "2026-11-09" and draft["due_time"] == "13:38"
    assert [(rule["mode"], rule["minutes"]) for rule in draft["rules"]] == [("before", 0)]
    assert model.call_count == int(enabled)
    if enabled:
        assert json.loads(model.call_args.args[4])["client_now"] == "2026-11-09T13:33:00+08:00"
    assert db.scalar(select(func.count()).select_from(Item)) == 0
    assert db.scalar(select(func.count()).select_from(Reminder)) == 0


def test_old_client_uses_one_server_instant(client):
    with patch("app.main.datetime", wraps=datetime) as clock:
        clock.now.return_value = datetime(2026, 11, 9, 5, 33, tzinfo=UTC)
        response = client.post(
            "/api/drafts/text",
            json={
                "text": "5分钟后提醒我",
                "local_date": "2026-11-09",
                "timezone": "Asia/Shanghai",
            },
        )
    assert response.status_code == 200
    assert response.json()["due_time"] == "13:38"


def test_ai_cannot_fill_an_ambiguous_countdown_with_default_time(client, monkeypatch):
    monkeypatch.setattr(settings(), "llm_encryption_key", Fernet.generate_key().decode())
    client.put(
        "/api/model-settings",
        json={
            "provider": "openai",
            "model": "test",
            "api_key": "test-key",
            "enabled": True,
        },
    )
    with patch(
        "app.ai_assistance.request_model",
        return_value=json.dumps(
            {
                "kind": "appointment",
                "title": "Test",
                "due_date": "2026-11-09",
                "due_time": "09:00",
            }
        ),
    ):
        response = client.post(
            "/api/drafts/text", json=context("in 5 minutes or in 10 minutes").model_dump(mode="json")
        )
    assert response.status_code == 200
    assert response.json()["due_date"] is None and response.json()["due_time"] is None
    assert response.json()["rules"] == [rule.model_dump() for rule in default_rules("appointment")]


def test_confirmation_creates_one_future_notification_and_dispatches_at_due_time(client, db):
    request = context("增加一个5分钟后的测试提示")
    response = client.post("/api/drafts/text", json=request.model_dump(mode="json"))
    assert response.status_code == 200
    with patch("app.reminders.now", return_value=request.client_now.astimezone(UTC)):
        saved = client.post("/api/items", json=response.json() | {"confirmed": True})
    assert saved.status_code == 201, saved.text
    row = db.scalar(select(Reminder))
    assert row and row.rule_key == "before:0" and row.status == "pending"
    expected = datetime(2026, 11, 9, 5, 38, tzinfo=UTC)
    assert row.fire_at == expected
    item = db.get(Item, saved.json()["id"])
    db.add(
        Device(
            user_id=item.user_id,
            client_key_hash="relative-test",
            platform="ios",
            subscription={"token": "fake"},
        )
    )
    db.commit()
    calls = []
    dispatch_one(db, row.id, lambda *args: calls.append(args), at=expected - timedelta(seconds=1))
    assert calls == []
    dispatch_one(db, row.id, lambda *args: calls.append(args), at=expected)
    assert len(calls) == 1 and row.status == "sent"


@pytest.mark.parametrize("text", ["今天取包裹", "2026-11-10 19:15 dentist", "明天水电120元"])
def test_existing_non_countdown_defaults_are_unchanged(text):
    draft = parse_text(context(text))
    assert draft.rules == default_rules(draft.kind)
