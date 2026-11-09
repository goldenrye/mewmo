from pathlib import Path
from unittest.mock import patch

import pytest
from alembic import command
from alembic.config import Config
from cryptography.fernet import Fernet
from sqlalchemy import create_engine, func, select, text

from app.auth import password_hash
from app.config import settings
from app.model_chain import BACKUP_WARNING
from app.model_provider import ModelUnavailable
from app.model_settings import decrypt_key, ordered_models
from app.models import Item, ModelFallback, ModelPreference, Note, Reminder, User
from tests.test_accounts import invite, login_admin, signup
from tests.test_ai import FILE_URL, tiny_image

ENTRIES = [
    {"provider": "openai", "model": "first-model", "api_key": "first-secret"},
    {"provider": "anthropic", "model": "second-model", "api_key": "second-secret"},
    {"provider": "gemini", "model": "third-model", "api_key": "third-secret"},
]
CONTEXT = {"text": "Dentist tomorrow at 19:15", "local_date": "2026-11-09", "timezone": "Asia/Shanghai"}
VALID = '{"kind":"appointment","title":"Dentist","due_date":"2026-11-10","due_time":"19:15"}'


@pytest.fixture(autouse=True)
def encryption(monkeypatch):
    monkeypatch.setattr(settings(), "llm_encryption_key", Fernet.generate_key().decode())


def save(client, entries=None, **changes):
    current = client.get("/api/model-settings").json()
    body = {
        "models": entries or ENTRIES,
        "revision": current["revision"],
        "enabled": True,
        "allow_images": False,
        "allow_note_search": True,
    } | changes
    response = client.put("/api/model-settings/models", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def retained(entry):
    return {key: entry[key] for key in ("id", "provider", "model")}


def test_save_reorder_keep_keys_remove_and_delete(client, db):
    initial = save(client)
    assert [item["model"] for item in initial["models"]] == [item["model"] for item in ENTRIES]
    assert all(entry["api_key"] not in str(initial) for entry in ENTRIES)
    row = db.scalar(select(ModelPreference))
    assert [decrypt_key(model) for model in ordered_models(row)] == [entry["api_key"] for entry in ENTRIES]
    second = save(
        client,
        [retained(initial["models"][1]), retained(initial["models"][0]), retained(initial["models"][2])],
    )
    assert second["provider"] == "anthropic"
    assert [decrypt_key(model) for model in ordered_models(row)] == [
        "second-secret",
        "first-secret",
        "third-secret",
    ]
    assert second["revision"] > initial["revision"]
    last = save(client, [retained(second["models"][1])])
    assert last["model"] == "first-model" and len(last["models"]) == 1
    assert decrypt_key(row) == "first-secret"
    assert db.scalar(select(func.count()).select_from(ModelFallback)) == 0
    current = save(client)
    assert client.delete(f"/api/model-settings?revision={current['revision']}").status_code == 204
    assert db.scalar(select(func.count()).select_from(ModelFallback)) == 0


def test_legacy_updates_cannot_erase_or_change_ordered_models(client):
    initial = save(client)
    assert client.put("/api/model-settings", json=ENTRIES[0] | {"enabled": False}).status_code == 409
    assert client.delete("/api/model-settings").status_code == 409
    assert client.get("/api/model-settings").json() == initial


def test_stale_save_is_rejected_without_changing_any_keys(client):
    first = save(client)
    current = save(client, [retained(first["models"][2]), retained(first["models"][1])])
    response = client.put(
        "/api/model-settings/models",
        json={
            "revision": first["revision"],
            "models": ENTRIES,
        },
    )
    assert response.status_code == 409
    assert client.get("/api/model-settings").json() == current
    assert client.delete(f"/api/model-settings?revision={first['revision']}").status_code == 409


@pytest.mark.parametrize("entries", [[], ENTRIES * 2, [ENTRIES[0] | {"model": "../escape"}]])
def test_invalid_or_oversized_lists_rejected(client, entries):
    assert (
        client.put("/api/model-settings/models", json={"revision": 0, "models": entries}).status_code == 422
    )
    assert not client.get("/api/model-settings").json()["has_key"]


def test_duplicate_foreign_ids_and_missing_keys_are_atomic(client):
    first = save(client)
    duplicate = retained(first["models"][1])
    for entries in (
        [duplicate, duplicate],
        [{"id": "foreign-id", **ENTRIES[0]}],
        [retained(first["models"][0]), {"provider": "gemini", "model": "new-model"}],
        [retained(first["models"][0]) | {"provider": "doubao"}],
    ):
        response = client.put(
            "/api/model-settings/models", json={"revision": first["revision"], "models": entries}
        )
        assert response.status_code == 400
        assert client.get("/api/model-settings").json() == first


def test_models_and_test_endpoint_are_account_scoped(client):
    owner = save(client)
    _, token = invite(client)
    assert signup(client, token).status_code == 201
    assert client.get("/api/model-settings").json()["models"] == []
    member = save(client, [ENTRIES[2]])
    response = client.put(
        "/api/model-settings/models",
        json={
            "revision": member["revision"],
            "models": [retained(owner["models"][1])],
        },
    )
    assert response.status_code == 400
    with patch("app.model_settings.request_model") as model:
        assert client.post(f"/api/model-settings/test?model_id={owner['models'][1]['id']}").status_code == 404
    model.assert_not_called()
    login_admin(client)
    assert client.get("/api/model-settings").json()["models"] == owner["models"]


@pytest.mark.parametrize("failure", [ModelUnavailable("secret error"), '{"status":"paid"}', "{}", "not JSON"])
def test_text_fallback_uses_order_stops_after_success_and_never_saves(client, db, failure):
    save(client)
    with patch("app.ai_assistance.request_model", side_effect=[failure, VALID]) as model:
        response = client.post("/api/drafts/text", json=CONTEXT)
    assert response.status_code == 200
    assert [call.args[1] for call in model.call_args_list] == ["first-model", "second-model"]
    assert [call.args[2] for call in model.call_args_list] == ["first-secret", "second-secret"]
    assert response.json()["due_time"] == "19:15" and response.json()["status"] == "open"
    assert BACKUP_WARNING in response.json()["warnings"]
    assert db.scalar(select(func.count()).select_from(Item)) == 0
    assert db.scalar(select(func.count()).select_from(Reminder)) == 0


def test_default_success_never_contacts_backups_and_each_capture_starts_at_first(client):
    save(client)
    with patch("app.ai_assistance.request_model", return_value=VALID) as model:
        client.post("/api/drafts/text", json=CONTEXT)
        client.post("/api/drafts/text", json=CONTEXT)
    assert [call.args[1] for call in model.call_args_list] == ["first-model", "first-model"]


def test_chain_reaches_fifth_model_and_deleted_configuration_cannot_reuse_consent(client):
    entries = [{"provider": "openai", "model": f"model-{i}", "api_key": f"key-{i}"} for i in range(5)]
    initial = save(client, entries, allow_images=True)
    with patch("app.ai_assistance.request_model", side_effect=[ModelUnavailable()] * 4 + [VALID]) as model:
        response = client.post("/api/drafts/text", json=CONTEXT)
    assert response.status_code == 200
    assert [call.args[1] for call in model.call_args_list] == [entry["model"] for entry in entries]
    assert all(call.kwargs["timeout"] == 15 for call in model.call_args_list)
    assert client.delete(f"/api/model-settings?revision={initial['revision']}").status_code == 204
    current = save(client, entries, allow_images=True)
    assert current["revision"] != initial["revision"]
    assert current["image_chain_token"] != initial["image_chain_token"]
    assert (
        client.put(
            "/api/model-settings/models",
            json={
                "revision": initial["revision"],
                "models": entries,
            },
        ).status_code
        == 409
    )


def test_all_models_fail_or_ai_disabled_keep_local_draft(client):
    initial = save(client)
    with patch("app.ai_assistance.request_model", side_effect=ModelUnavailable("secret")) as model:
        response = client.post("/api/drafts/text", json=CONTEXT)
    assert model.call_count == 3
    assert response.json()["due_time"] == "19:15"
    assert "secret" not in response.text
    save(client, [retained(entry) for entry in initial["models"]], enabled=False)
    with patch("app.ai_assistance.request_model") as model:
        assert client.post("/api/drafts/text", json=CONTEXT).status_code == 200
    model.assert_not_called()


def test_invalid_key_can_fall_back_to_next_credential(client, db):
    save(client)
    row = db.scalar(select(ModelPreference))
    row.encrypted_key = "unreadable"
    db.commit()
    with patch("app.ai_assistance.request_model", return_value=VALID) as model:
        assert client.post("/api/drafts/text", json=CONTEXT).status_code == 200
    assert model.call_args.args[1:3] == ("second-model", "second-secret")


def test_note_search_fallback_only_sends_query(client, db):
    save(client)
    db.add(
        Note(
            user_id=db.scalar(select(User.id)),
            title="Floor",
            body="private 12500 mm",
            search_text="floor private 12500 mm",
        )
    )
    db.commit()
    with patch("app.note_search.request_model", side_effect=["invalid", '{"terms":["floor"]}']) as model:
        response = client.post("/api/notes/search", json={"query": "floor"})
    assert response.json()["mode"] == "ai" and response.json()["total"] == 1
    assert response.json()["warning"] == BACKUP_WARNING
    assert [call.args[1] for call in model.call_args_list] == ["first-model", "second-model"]
    assert all("12500" not in call.args[4] for call in model.call_args_list)
    with patch("app.note_search.request_model", side_effect=ModelUnavailable) as model:
        response = client.post("/api/notes/search", json={"query": "floor"})
    assert model.call_count == 3 and response.json()["mode"] == "local"
    assert response.json()["total"] == 1


def test_image_fallback_requires_current_chain_consent(client):
    initial = save(client, allow_images=True)
    with patch("app.ai_assistance.request_model") as model:
        assert (
            client.post(
                FILE_URL + "&use_image_ai=true&image_provider=openai", content=tiny_image()
            ).status_code
            == 400
        )
    model.assert_not_called()
    url = (
        FILE_URL
        + f"&use_image_ai=true&image_provider=openai&image_revision={initial['revision']}&image_chain={initial['image_chain_token']}"
    )
    with (
        patch("app.main.extract_file", return_value="Meeting\nDate: 2026-11-10\nTime: 19:15"),
        patch("app.ai_assistance.request_model", side_effect=[ModelUnavailable(), VALID]) as model,
    ):
        response = client.post(url, content=tiny_image())
    assert response.status_code == 200
    assert len(model.call_args_list[0].args[5]) == len(model.call_args_list[1].args[5]) == 1
    assert BACKUP_WARNING in response.json()["warnings"]
    save(client, [retained(initial["models"][0]), retained(initial["models"][2])], allow_images=True)
    with patch("app.ai_assistance.request_model") as model:
        assert client.post(url, content=tiny_image()).status_code == 400
    model.assert_not_called()


def test_connection_test_targets_one_model_not_the_chain(client):
    initial = save(client)
    with patch("app.model_settings.request_model", return_value='{"ok":true}') as model:
        response = client.post(f"/api/model-settings/test?model_id={initial['models'][1]['id']}")
    assert response.status_code == 200 and model.call_count == 1
    assert model.call_args.args[1:3] == ("second-model", "second-secret")


def test_migration_keeps_primary_credentials_and_consent(tmp_path, monkeypatch):
    monkeypatch.setattr(settings(), "admin_password_hash", password_hash("test-password-long"))
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "migrations"))
    engine = create_engine(f"sqlite:///{tmp_path}/fallbacks.db")
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, "0005")
        owner = connection.scalar(select(User.id))
        connection.execute(
            text(
                "INSERT INTO model_preferences (user_id, provider, model, encrypted_key, enabled, allow_images, allow_note_search) "
                "VALUES (:owner, 'openai', 'original', 'encrypted-unchanged', true, false, true)"
            ),
            {"owner": owner},
        )
        command.upgrade(config, "head")
        row = connection.execute(select(ModelPreference)).mappings().one()
        assert row["model"] == "original" and row["encrypted_key"] == "encrypted-unchanged"
        assert row["enabled"] and row["allow_note_search"] and not row["allow_images"]
        assert row["revision"] == 1
        assert connection.scalar(select(func.count()).select_from(ModelFallback)) == 0
    engine.dispose()
