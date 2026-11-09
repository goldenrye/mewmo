from unittest.mock import MagicMock, patch

import pytest

from app.config import settings
from app.models import Device
from app.push import PushFailure, send_push


def test_apns_acceptance_and_separate_notification_ids(tmp_path, monkeypatch):
    key = tmp_path / "key.p8"
    key.write_text("test-key")
    config = settings()
    monkeypatch.setattr(config, "apns_key_path", str(key))
    monkeypatch.setattr(config, "apns_key_id", "TEST")
    monkeypatch.setattr(config, "apns_team_id", "TESTTEAM")
    device = Device(platform="ios", subscription={"token": "a" * 64})
    payload = {
        "title": "Utility",
        "body": "Sunday, 2026-11-08 at 09:00",
        "item_id": "item",
        "reminder_id": "unique-reminder",
    }
    response = MagicMock(status_code=200)
    with patch("app.push.jwt.encode", return_value="test-jwt"), patch("app.push.httpx.Client") as client:
        client.return_value.__enter__.return_value.post.return_value = response
        send_push(device, payload)
        kwargs = client.return_value.__enter__.return_value.post.call_args.kwargs
        assert kwargs["headers"]["apns-id"] == payload["reminder_id"]
        assert "apns-collapse-id" not in kwargs["headers"]
        assert "amount" not in str(kwargs["json"])
        assert kwargs["json"]["aps"]["alert"]["body"] == payload["body"]
        response.status_code = 503
        response.headers = {}
        with pytest.raises(PushFailure, match="apns_http_503"):
            send_push(device, payload)


def test_missing_web_push_config_never_claims_acceptance(monkeypatch):
    monkeypatch.setattr(settings(), "vapid_private_key", "")
    with pytest.raises(PushFailure, match="web_push_not_configured"):
        send_push(Device(platform="web", subscription={}), {})


def test_unreadable_apns_key_reports_specific_code(tmp_path, monkeypatch):
    config = settings()
    monkeypatch.setattr(config, "apns_key_path", str(tmp_path / "missing.p8"))
    monkeypatch.setattr(config, "apns_key_id", "TEST")
    monkeypatch.setattr(config, "apns_team_id", "TESTTEAM")
    device = Device(platform="ios", subscription={"token": "a" * 64})
    with pytest.raises(PushFailure, match="apns_key_unreadable") as raised:
        send_push(device, {"reminder_id": "r", "item_id": "i", "title": "t", "body": "b"})
    assert not raised.value.permanent
