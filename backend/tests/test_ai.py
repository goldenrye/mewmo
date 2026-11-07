import base64
import io
import json
from unittest.mock import patch

import httpx
import pytest
from cryptography.fernet import Fernet
from fastapi import HTTPException
from PIL import Image
from sqlalchemy import func, select

from app.ai_assistance import AI_FAILURE, IMAGE_WARNING, image_parts, redact_model_text
from app.config import settings
from app.model_provider import ModelUnavailable, request_model
from app.model_settings import decrypt_key
from app.models import Item, ModelPreference, Reminder
from app.parsing import ParseFailure
from tests.test_accounts import invite, login_admin, signup

KEY = "test-provider-key-never-display"
MODEL = {
    "provider": "openai",
    "model": "example-model",
    "api_key": KEY,
    "enabled": True,
    "allow_images": False,
}
SUGGESTION = json.dumps(
    {
        "is_bill": True,
        "kind": "bill",
        "title": "Boost Mobile",
        "payee": "Boost Mobile",
        "amount": "61.78",
        "currency": "USD",
        "due_date": "2026-11-12",
    }
)
FILE_URL = "/api/drafts/file?local_date=2026-11-06&timezone=Asia/Shanghai"


@pytest.fixture(autouse=True)
def encryption(monkeypatch):
    monkeypatch.setattr(settings(), "llm_encryption_key", Fernet.generate_key().decode())


def save(client, **values):
    response = client.put("/api/model-settings", json=MODEL | values)
    assert response.status_code == 200, response.text
    return response.json()


def test_settings_encrypt_keys_never_return_them_and_delete(client, db):
    assert not client.get("/api/model-settings").json()["has_key"]
    result = save(client)
    assert result["has_key"] and result["enabled"]
    assert KEY not in json.dumps(result)
    row = db.scalar(select(ModelPreference))
    assert KEY not in row.encrypted_key
    assert decrypt_key(row) == KEY
    assert KEY not in client.get("/api/model-settings").text
    save(client, api_key=None, model="other-model", enabled=False)
    assert decrypt_key(row) == KEY
    assert not row.enabled
    assert client.delete("/api/model-settings").status_code == 204
    assert db.scalar(select(ModelPreference)) is None


def test_configuration_defaults_off_and_auth_required(client):
    result = client.put(
        "/api/model-settings",
        json={
            "provider": "openai",
            "model": "example-model",
            "api_key": KEY,
        },
    ).json()
    assert not result["enabled"] and not result["allow_images"]
    client.cookies.clear()
    for method, path in [("get", ""), ("put", ""), ("delete", ""), ("post", "/test")]:
        assert getattr(client, method)("/api/model-settings" + path).status_code == 401


def test_credentials_and_settings_are_private_and_owner_bound(client, db):
    save(client)
    owner_row = db.scalar(select(ModelPreference))
    _, token = invite(client)
    assert signup(client, token).status_code == 201
    assert not client.get("/api/model-settings").json()["has_key"]
    assert client.post("/api/model-settings/test").status_code == 400
    save(client, api_key="member-key", provider="anthropic")
    member_row = db.scalar(select(ModelPreference).where(ModelPreference.user_id != owner_row.user_id))
    assert decrypt_key(member_row) == "member-key"
    member_row.encrypted_key = owner_row.encrypted_key
    with pytest.raises(ModelUnavailable):
        decrypt_key(member_row)
    client.delete("/api/model-settings")
    login_admin(client)
    assert client.get("/api/model-settings").json()["provider"] == "openai"
    assert decrypt_key(owner_row) == KEY


@pytest.mark.parametrize(
    "changes",
    [
        {"model": "../../evil"},
        {"model": "model?key=secret"},
        {"provider": "custom"},
        {"api_key": "key\ninjected-header"},
        {"base_url": "http://169.254.169.254"},
        {"user_id": "another-user"},
    ],
)
def test_rejects_custom_endpoints_path_injection_and_secret_echo(client, changes):
    response = client.put("/api/model-settings", json=MODEL | changes)
    assert response.status_code == 422
    assert KEY not in response.text
    assert "injected-header" not in response.text


@pytest.mark.parametrize("provider", ["anthropic", "gemini", "doubao"])
def test_changing_provider_requires_new_key(client, provider):
    save(client)
    response = client.put("/api/model-settings", json=MODEL | {"provider": provider, "api_key": None})
    assert response.status_code == 400
    assert client.get("/api/model-settings").json()["provider"] == "openai"


def test_missing_encryption_fails_closed_but_allows_removal(client, monkeypatch):
    save(client)
    monkeypatch.setattr(settings(), "llm_encryption_key", "")
    assert not client.get("/api/model-settings").json()["available"]
    response = client.put("/api/model-settings", json=MODEL)
    assert response.status_code == 503
    assert KEY not in response.text
    assert client.delete("/api/model-settings").status_code == 204


def test_doubao_endpoint_id_can_be_saved_and_tested_privately(client, db):
    endpoint = "ep-20261107000000-example"
    value = save(client, provider="doubao", model=endpoint)
    assert value["provider"] == "doubao" and value["model"] == endpoint
    assert KEY not in json.dumps(value)
    assert decrypt_key(db.scalar(select(ModelPreference))) == KEY
    with patch("app.model_settings.request_model", return_value='{"ok":true}') as call:
        assert client.post("/api/model-settings/test").json() == {"ok": True}
    assert call.call_args.args[:3] == ("doubao", endpoint, KEY)


def test_test_connection_uses_synthetic_input_and_sanitizes_errors(client):
    save(client, enabled=False)
    with patch("app.model_settings.request_model", return_value='{"ok": true}') as call:
        assert client.post("/api/model-settings/test").json() == {"ok": True}
    assert call.call_args.args[:3] == ("openai", "example-model", KEY)
    assert "No customer data" in call.call_args.args[4]
    with patch("app.model_settings.request_model", side_effect=ModelUnavailable(KEY)):
        response = client.post("/api/model-settings/test")
    assert response.status_code == 400
    assert KEY not in response.text


def test_default_local_only_never_calls_provider(client):
    with patch("app.ai_assistance.request_model") as call:
        response = client.post(
            "/api/drafts/text",
            json={
                "text": "后天9点有医生预约",
                "local_date": "2026-11-06",
                "timezone": "Asia/Shanghai",
            },
        )
    call.assert_not_called()
    assert response.json()["due_date"] == "2026-11-08"


@pytest.mark.parametrize("provider", ["openai", "anthropic", "gemini", "doubao"])
def test_ai_file_suggestions_stay_draft_and_redact_accounts(client, db, provider):
    save(client, provider=provider)
    source = "BILL\nAccount: 1234 5678 9999\nAmount due: $61.78\nDue date\nunreadable"
    with (
        patch("app.main.extract_file", return_value=source),
        patch(
            "app.ai_assistance.request_model",
            return_value=SUGGESTION,
        ) as call,
    ):
        response = client.post(FILE_URL, content=b"file")
    assert response.status_code == 200
    draft = response.json()
    assert draft["payee"] == "Boost Mobile"
    assert draft["due_date"] == "2026-11-12"
    assert draft["status"] == "open" and draft["account_last4"] == "9999"
    assert {"payee", "due_date"} <= set(draft["uncertain"])
    assert "1234" not in call.call_args.args[4]
    assert call.call_args.args[5] == ()
    assert call.call_args.args[0] == provider
    assert db.scalar(select(func.count()).select_from(Item)) == 0
    assert db.scalar(select(func.count()).select_from(Reminder)) == 0


@pytest.mark.parametrize(
    "output",
    [
        '{"status":"paid"}',
        '{"rules":[]}',
        '{"user_id":"admin"}',
        '{"amount":"-20"}',
        '{"due_time":"25:00"}',
        '{"due_date":"not-a-date"}',
        "not json",
    ],
)
def test_unsafe_or_invalid_model_output_falls_back(client, output):
    save(client)
    with patch("app.ai_assistance.request_model", return_value=output):
        response = client.post(
            "/api/drafts/text",
            json={
                "text": "后天9点有医生预约",
                "local_date": "2026-11-06",
                "timezone": "Asia/Shanghai",
            },
        )
    draft = response.json()
    assert draft["title"] == "医生预约"
    assert draft["due_date"] == "2026-11-08"
    assert draft["status"] == "open"
    assert AI_FAILURE in draft["warnings"]


def test_confident_local_fields_are_not_overwritten(client):
    save(client)
    with (
        patch(
            "app.main.extract_file",
            return_value="BILL\nPayee: Local Co\nAmount due: USD 42\nDue date: 2026-11-10",
        ),
        patch(
            "app.ai_assistance.request_model",
            return_value=SUGGESTION,
        ),
    ):
        draft = client.post(FILE_URL, content=b"file").json()
    assert draft["payee"] == "Local Co" and draft["due_date"] == "2026-11-10"
    assert draft["amount"] == "42"
    assert {"payee", "amount", "due_date"} <= set(draft["uncertain"])


def test_failure_and_disabled_settings_keep_local_parser_usable(client):
    save(client)
    body = {"text": "明天下午3点 doctor appointment", "local_date": "2026-11-06", "timezone": "UTC"}
    with patch("app.ai_assistance.request_model", side_effect=ModelUnavailable(KEY)):
        response = client.post("/api/drafts/text", json=body)
    assert response.status_code == 200 and KEY not in response.text
    assert response.json()["due_time"] == "15:00"
    save(client, enabled=False)
    with patch("app.ai_assistance.request_model") as call:
        assert client.post("/api/drafts/text", json=body).status_code == 200
    call.assert_not_called()


def tiny_image():
    buffer = io.BytesIO()
    Image.new("RGB", (100, 100), "white").save(buffer, format="PNG")
    return buffer.getvalue()


def test_images_require_both_account_and_per_import_consent(client):
    save(client)
    with patch("app.ai_assistance.request_model") as call:
        assert client.post(FILE_URL + "&use_image_ai=true", content=tiny_image()).status_code == 400
    call.assert_not_called()
    save(client, allow_images=True)
    with (
        patch("app.main.extract_file", return_value="BILL\nAmount due: USD 61.78"),
        patch(
            "app.ai_assistance.request_model",
            return_value=SUGGESTION,
        ) as call,
    ):
        client.post(FILE_URL, content=tiny_image())
    assert call.call_args.args[5] == ()
    with (
        patch("app.main.extract_file", side_effect=ParseFailure("Local OCR unavailable")),
        patch(
            "app.ai_assistance.request_model",
            return_value=SUGGESTION,
        ) as call,
    ):
        response = client.post(FILE_URL + "&use_image_ai=true&image_provider=openai", content=tiny_image())
    assert response.status_code == 200
    assert len(call.call_args.args[5]) == 1
    assert IMAGE_WARNING in response.json()["warnings"]
    assert response.json()["status"] == "open"


def test_not_a_bill_image_cannot_become_a_saved_item(client, db):
    save(client, allow_images=True)
    with (
        patch("app.main.extract_file", side_effect=ParseFailure("Not a bill")),
        patch(
            "app.ai_assistance.request_model",
            return_value='{"is_bill":false}',
        ),
    ):
        response = client.post(FILE_URL + "&use_image_ai=true&image_provider=openai", content=tiny_image())
    assert response.status_code == 422
    assert db.scalar(select(func.count()).select_from(Item)) == 0


def test_changed_image_provider_requires_new_consent(client):
    save(client, allow_images=True, provider="gemini")
    with patch("app.ai_assistance.request_model") as call:
        response = client.post(FILE_URL + "&use_image_ai=true&image_provider=openai", content=tiny_image())
    assert response.status_code == 400
    call.assert_not_called()


def test_other_account_never_uses_owners_model(client):
    save(client)
    _, token = invite(client)
    signup(client, token)
    with patch("app.ai_assistance.request_model") as call:
        response = client.post(
            "/api/drafts/text",
            json={
                "text": "Dentist tomorrow at 9am",
                "local_date": "2026-11-06",
                "timezone": "UTC",
            },
        )
    assert response.status_code == 200
    call.assert_not_called()


def test_zero_amount_and_paid_text_status_are_preserved(client):
    save(client)
    with (
        patch("app.main.extract_file", return_value="BILL\nAmount due: USD 0"),
        patch(
            "app.ai_assistance.request_model",
            return_value=SUGGESTION,
        ),
    ):
        draft = client.post(FILE_URL, content=b"file").json()
    assert draft["amount"] == "0"
    with patch("app.ai_assistance.request_model", return_value=SUGGESTION):
        draft = client.post(
            "/api/drafts/text",
            json={
                "text": "这个月水电 120 刀，已付",
                "local_date": "2026-11-06",
                "timezone": "Asia/Shanghai",
            },
        ).json()
    assert draft["status"] == "paid"
    assert draft["amount"] == "120"


def test_bad_encryption_and_rate_limit_do_not_send_content(client, monkeypatch):
    save(client)
    monkeypatch.setattr(settings(), "llm_encryption_key", Fernet.generate_key().decode())
    with patch("app.ai_assistance.request_model") as call:
        response = client.post(
            "/api/drafts/text",
            json={
                "text": "Dentist tomorrow",
                "local_date": "2026-11-06",
                "timezone": "UTC",
            },
        )
    assert AI_FAILURE in response.json()["warnings"]
    call.assert_not_called()
    with (
        patch("app.ai_assistance.throttle", side_effect=HTTPException(429)),
        patch(
            "app.ai_assistance.request_model",
        ) as call,
    ):
        response = client.post(
            "/api/drafts/text",
            json={
                "text": "Dentist tomorrow",
                "local_date": "2026-11-06",
                "timezone": "UTC",
            },
        )
    assert response.status_code == 200
    call.assert_not_called()


def test_image_normalization_has_no_original_metadata():
    result = image_parts(tiny_image())
    image = Image.open(io.BytesIO(base64.b64decode(result[0])))
    assert image.format == "PNG" and image.info == {}
    with pytest.raises(ModelUnavailable):
        image_parts(b"invalid")


def test_redaction_preserves_dates_and_amounts_but_not_account_numbers():
    result = redact_model_text("Account: 1234 5678 9999. Due 2026-11-12. Amount USD 12000.50")
    assert "1234" not in result and "****9999" in result
    assert "2026-11-12" in result and "12000.50" in result


@pytest.mark.parametrize(
    "provider,host,response",
    [
        (
            "openai",
            "api.openai.com",
            {"choices": [{"finish_reason": "stop", "message": {"content": '{"ok":true}'}}]},
        ),
        (
            "doubao",
            "ark.cn-beijing.volces.com",
            {"choices": [{"finish_reason": "stop", "message": {"content": '{"ok":true}'}}]},
        ),
        (
            "anthropic",
            "api.anthropic.com",
            {"stop_reason": "end_turn", "content": [{"type": "text", "text": '{"ok":true}'}]},
        ),
        (
            "gemini",
            "generativelanguage.googleapis.com",
            {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": '{"ok":true}'}]}}]},
        ),
    ],
)
def test_provider_requests_use_fixed_hosts_no_tools_or_query_keys(provider, host, response):
    real_client = httpx.Client
    requests = []

    def handle(request):
        requests.append(request)
        return httpx.Response(200, json=response)

    def client_factory(**kwargs):
        assert kwargs["trust_env"] is False and kwargs["follow_redirects"] is False
        return real_client(transport=httpx.MockTransport(handle), **kwargs)

    with patch("app.model_provider.httpx.Client", side_effect=client_factory):
        assert json.loads(
            request_model(provider, "example-model", KEY, "system", "prompt", ["aW1hZ2U="])
        ) == {"ok": True}
    request = requests[0]
    assert request.url.host == host and request.url.scheme == "https"
    assert KEY not in str(request.url) and KEY not in request.content.decode()
    assert "tools" not in request.content.decode()
    assert "aW1hZ2U=" in request.content.decode()
    if provider == "doubao":
        body = json.loads(request.content)
        assert request.url.path == "/api/v3/chat/completions"
        assert request.headers["Authorization"] == f"Bearer {KEY}"
        assert body["max_tokens"] == 1600
        assert body["thinking"] == {"type": "disabled"}
        assert body["response_format"] == {"type": "json_object"}
        assert "max_completion_tokens" not in body and "store" not in body


@pytest.mark.parametrize(
    "status,content",
    [
        (302, b""),
        (401, KEY.encode()),
        (500, b"error"),
        (200, b"x" * 70000),
        (200, b"not JSON"),
    ],
)
def test_provider_rejects_redirects_errors_and_oversized_responses(status, content):
    real_client = httpx.Client
    transport = httpx.MockTransport(
        lambda request: httpx.Response(status, content=content, headers={"Location": "https://evil.example"})
    )
    with patch(
        "app.model_provider.httpx.Client", side_effect=lambda **kw: real_client(transport=transport, **kw)
    ):
        with pytest.raises(ModelUnavailable) as error:
            request_model("openai", "example-model", KEY, "system", "prompt")
    assert KEY not in str(error.value)


@pytest.mark.parametrize(
    "provider,result",
    [
        ("openai", {"choices": [None]}),
        ("doubao", {"choices": [None]}),
        ("anthropic", []),
        ("gemini", {"candidates": ["not an object"]}),
    ],
)
def test_malformed_provider_envelopes_raise_sanitized_error(provider, result):
    real_client = httpx.Client
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=result))
    with patch(
        "app.model_provider.httpx.Client", side_effect=lambda **kw: real_client(transport=transport, **kw)
    ):
        with pytest.raises(ModelUnavailable):
            request_model(provider, "example-model", KEY, "system", "prompt")
