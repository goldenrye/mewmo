import json
from unittest.mock import patch

import pytest
from sqlalchemy import func, select

from app.ai_assistance import AI_FAILURE
from app.model_provider import ModelUnavailable
from app.models import Item, Reminder
from app.parsing import parse_text
from app.schemas import ParseRequest, default_rules
from tests.test_ai import FILE_URL, save, tiny_image
from tests.test_ai import encryption as encryption
from tests.test_model_fallbacks import save as save_chain

BODY = {
    "text": "This is not a bill; remind me to discuss the invoice at the team meeting next Friday.",
    "local_date": "2026-11-09",
    "timezone": "Asia/Shanghai",
    "client_now": "2026-11-09T13:33:00+08:00",
}
ANSWER = {
    "kind": "appointment",
    "title": "Discuss the invoice",
    "due_date": "2026-11-13",
    "due_time": "15:30",
}


def test_ai_understands_intent_without_local_kind_or_title_winning(client, db):
    save(client)
    assert parse_text(ParseRequest(**BODY)).kind == "bill"
    with (
        patch("app.main.parse_text", side_effect=AssertionError("No local draft on AI success")),
        patch("app.ai_assistance.request_model", return_value=json.dumps(ANSWER)),
    ):
        response = client.post("/api/drafts/text", json=BODY)
    assert response.status_code == 200, response.text
    draft = response.json()
    assert {key: draft[key] for key in ANSWER} == ANSWER
    assert draft["interpretation"] == "ai" and draft["status"] == "open"
    assert draft["amount"] is None and draft["payee"] is None
    assert draft["rules"] == [rule.model_dump() for rule in default_rules("appointment")]
    assert db.scalar(select(func.count()).select_from(Item)) == 0
    assert db.scalar(select(func.count()).select_from(Reminder)) == 0


@pytest.mark.parametrize("configured", [False, True])
def test_no_ai_or_saved_opt_out_uses_only_local_parser(client, configured):
    if configured:
        save(client, enabled=False)
    with patch("app.ai_assistance.request_model") as model:
        response = client.post("/api/drafts/text", json=BODY)
    model.assert_not_called()
    assert response.json()["interpretation"] == "local"
    assert AI_FAILURE not in response.json()["warnings"]


def test_all_models_fail_before_local_parser_is_used(client):
    save_chain(client)
    order = []

    def unavailable(*args, **kwargs):
        order.append(args[1])
        raise ModelUnavailable()

    def local(request):
        order.append("local")
        return parse_text(request)

    with (
        patch("app.ai_assistance.request_model", side_effect=unavailable),
        patch("app.main.parse_text", side_effect=local),
    ):
        response = client.post("/api/drafts/text", json=BODY)
    assert order == ["first-model", "second-model", "third-model", "local"]
    assert response.json()["interpretation"] == "local"
    assert AI_FAILURE in response.json()["warnings"]


@pytest.mark.parametrize(
    "bad",
    [
        {"kind": "appointment", "title": " "},
        {"kind": "bill", "is_bill": False, "title": "Contradiction"},
        ANSWER | {"due_time": "25:00"},
        ANSWER | {"status": "completed"},
        ANSWER | {"rules": []},
        ANSWER | {"account_last4": "1234"},
        ANSWER | {"interpretation": "local"},
        ANSWER | {"due_date": "2026-03-08", "due_time": "02:30"},
    ],
)
def test_unusable_ai_response_tries_backup_before_using_local(client, bad):
    save_chain(client)
    with (
        patch("app.main.parse_text", side_effect=AssertionError("Backup should succeed")),
        patch("app.ai_assistance.request_model", side_effect=[json.dumps(bad), json.dumps(ANSWER)]) as model,
    ):
        response = client.post(
            "/api/drafts/text",
            json=BODY | {"timezone": "America/Los_Angeles", "client_now": "2026-11-09T13:33:00-08:00"},
        )
    assert response.status_code == 200, response.text
    assert model.call_count == 2
    assert response.json()["interpretation"] == "ai"


@pytest.mark.parametrize("kind", ["bill", "appointment", "dated_item"])
def test_missing_ai_fields_are_not_silently_filled_by_local_guesses(client, kind):
    save(client)
    with patch(
        "app.ai_assistance.request_model",
        return_value=json.dumps({"kind": kind, "title": "Needs review"}),
    ):
        response = client.post("/api/drafts/text", json=BODY)
    draft = response.json()
    assert draft["interpretation"] == "ai"
    assert draft["due_date"] is None and draft["due_time"] is None
    assert draft["amount"] is None and draft["payee"] is None
    assert {"due_date", "due_time"} <= set(draft["uncertain"])


def test_model_can_resolve_multiple_clock_mentions_instead_of_first_clock_winning(client):
    save(client)
    with patch(
        "app.ai_assistance.request_model",
        return_value=json.dumps(ANSWER | {"due_time": "19:15"}),
    ):
        response = client.post(
            "/api/drafts/text", json=BODY | {"text": "Not 09:00; move the appointment to 19:15 tomorrow"}
        )
    assert response.json()["due_time"] == "19:15"
    assert "due_time" in response.json()["uncertain"]


def test_file_failure_restores_local_fields_and_reports_image_attempt(client):
    save(client, allow_images=True)
    with (
        patch(
            "app.main.extract_file",
            return_value="BILL\nPayee: Local Co\nAmount due: USD 42\nDue date: 2026-11-10",
        ),
        patch("app.ai_assistance.request_model", side_effect=ModelUnavailable()),
    ):
        response = client.post(FILE_URL + "&use_image_ai=true&image_provider=openai", content=tiny_image())
    draft = response.json()
    assert draft["interpretation"] == "local"
    assert draft["payee"] == "Local Co" and draft["amount"] == "42"
    assert AI_FAILURE in draft["warnings"]
    assert any("Images may have been sent" in note for note in draft["warnings"])
