import json
from datetime import date, datetime, timezone
from unittest.mock import patch

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import func, select

from app.config import settings
from app.file_reminders import parse_file
from app.models import Item, Reminder
from app.parsing import parse_text
from app.schemas import ParseRequest


def context(text):
    return ParseRequest(text=text, local_date=date(2026, 11, 11), timezone="Asia/Shanghai")


@pytest.mark.parametrize(
    "text,expected",
    [
        ("请提醒我下午19:15要坐飞机", "19:15"),
        ("今天19:15要坐飞机", "19:15"),
        ("19:15坐飞机", "19:15"),
        ("请提醒我下午19：15要坐飞机", "19:15"),
        ("今天下午7:15要坐飞机", "19:15"),
        ("今天上午7:15要坐飞机", "07:15"),
        ("今天晚上7：15要坐飞机", "19:15"),
        ("今天12:00am坐飞机", "00:00"),
        ("今天12:00pm坐飞机", "12:00"),
        ("今天7pm坐飞机", "19:00"),
        ("Flight today at 19:15", "19:15"),
        ("Flight today at 7:15 pm", "19:15"),
        ("今天下午七点十五分坐飞机", "19:15"),
    ],
)
def test_explicit_time_adjacent_to_chinese(text, expected):
    draft = parse_text(context(text))
    assert draft.due_time == expected
    assert "due_time" not in draft.uncertain
    assert "19:15" not in draft.title and "19：15" not in draft.title


@pytest.mark.parametrize("clock", ["25:15", "19:99", "13pm", "0am", "123:15", "19:150"])
def test_invalid_time_is_not_a_confident_default(clock):
    draft = parse_text(context(f"今天{clock}要坐飞机"))
    assert "due_time" in draft.uncertain


def test_default_time_is_uncertain():
    draft = parse_text(context("今天取包裹"))
    assert draft.due_time == "09:00" and "due_time" in draft.uncertain


@pytest.mark.parametrize("clock", ["25:15", "19:99", "13pm", "0am"])
def test_recognized_invalid_clock_requires_manual_time(clock):
    draft = parse_text(context(f"今天{clock}要坐飞机"))
    assert draft.due_time is None


@pytest.mark.parametrize("clock", ["下午19:15", "下午7：15", "19:15"])
def test_file_reminder_uses_same_clock_parser(clock):
    draft = parse_file(f"今天{clock}有医生预约", context("file"))
    assert draft.due_time == "19:15" and "due_time" not in draft.uncertain


@pytest.mark.parametrize("enabled", [False, True])
@pytest.mark.parametrize("model_time", ["19:15", "09:00", None])
def test_explicit_time_survives_ai_and_stays_unsaved(client, db, monkeypatch, enabled, model_time):
    monkeypatch.setattr(settings(), "llm_encryption_key", Fernet.generate_key().decode())
    assert (
        client.put(
            "/api/model-settings",
            json={
                "provider": "openai",
                "model": "test-model",
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
                "kind": "appointment",
                "title": "坐飞机",
                "due_date": "2026-11-11",
                "due_time": model_time,
            }
        ),
    ) as model:
        response = client.post(
            "/api/drafts/text",
            json=context("今天请提醒我下午19:15要坐飞机").model_dump(mode="json"),
        )
    assert response.status_code == 200, response.text
    assert response.json()["due_time"] == "19:15"
    assert response.json()["due_date"] == "2026-11-11"
    assert response.json()["status"] == "open"
    assert model.call_count == int(enabled)
    assert db.scalar(select(func.count()).select_from(Item)) == 0
    assert db.scalar(select(func.count()).select_from(Reminder)) == 0


@pytest.mark.parametrize("model_time", ["19:15", None])
def test_ai_can_replace_default_but_appointment_never_inherits_it(client, monkeypatch, model_time):
    monkeypatch.setattr(settings(), "llm_encryption_key", Fernet.generate_key().decode())
    assert (
        client.put(
            "/api/model-settings",
            json={
                "provider": "openai",
                "model": "test-model",
                "api_key": "test-key",
                "enabled": True,
            },
        ).status_code
        == 200
    )
    with patch(
        "app.ai_assistance.request_model",
        return_value=json.dumps(
            {
                "kind": "appointment",
                "title": "坐飞机",
                "due_time": model_time,
            }
        ),
    ):
        response = client.post(
            "/api/drafts/text",
            json=context("今天坐飞机").model_dump(mode="json"),
        )
    assert response.status_code == 200
    assert response.json()["kind"] == "appointment"
    assert response.json()["due_time"] == model_time
    assert "due_time" in response.json()["uncertain"]


def test_confirmation_persists_1915_in_client_timezone(client):
    response = client.post(
        "/api/drafts/text",
        json=context("2026年11月11日请提醒我下午19:15要坐飞机").model_dump(mode="json"),
    )
    assert response.status_code == 200
    draft = response.json()
    assert draft["due_time"] == "19:15"
    response = client.post("/api/items", json=draft | {"confirmed": True})
    assert response.status_code == 201, response.text
    due_at = datetime.fromisoformat(response.json()["due_at"])
    assert due_at == datetime(2026, 11, 11, 11, 15, tzinfo=timezone.utc)
