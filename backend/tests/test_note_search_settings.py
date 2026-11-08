from pathlib import Path
from unittest.mock import patch

from alembic import command
from alembic.config import Config
from cryptography.fernet import Fernet
from sqlalchemy import create_engine, select, text

from app.auth import password_hash
from app.config import settings
from app.models import ModelPreference, Note, User
from tests.test_accounts import invite, login_admin, signup

MODEL = {"provider": "openai", "model": "test", "api_key": "fake-key", "enabled": True}


def test_new_setup_default_is_displayed_but_legacy_save_does_not_grant_consent(client, monkeypatch):
    monkeypatch.setattr(settings(), "llm_encryption_key", Fernet.generate_key().decode())
    initial = client.get("/api/model-settings").json()
    assert initial["allow_note_search"] and not initial["has_key"] and not initial["enabled"]
    saved = client.put("/api/model-settings", json=MODEL).json()
    assert saved["enabled"] and not saved["allow_note_search"]
    with patch("app.note_search.request_model") as model:
        client.post("/api/notes/search", json={"query": "floor", "use_ai": True})
    model.assert_not_called()


def test_preference_persists_and_master_toggle_or_legacy_saves_do_not_reset_it(client, monkeypatch):
    monkeypatch.setattr(settings(), "llm_encryption_key", Fernet.generate_key().decode())
    assert client.put("/api/model-settings", json=MODEL | {"allow_note_search": True}).json()[
        "allow_note_search"
    ]
    assert client.get("/api/model-settings").json()["allow_note_search"]
    assert client.put("/api/model-settings", json=MODEL | {"enabled": False}).json()["allow_note_search"]
    assert client.put("/api/model-settings", json=MODEL).json()["allow_note_search"]
    assert not client.put("/api/model-settings", json=MODEL | {"allow_note_search": False}).json()[
        "allow_note_search"
    ]
    assert not client.put("/api/model-settings", json=MODEL | {"allow_note_search": None}).json()[
        "allow_note_search"
    ]
    assert client.delete("/api/model-settings").status_code == 204
    assert client.get("/api/model-settings").json()["allow_note_search"]


def test_note_search_setting_is_account_scoped(client, monkeypatch):
    monkeypatch.setattr(settings(), "llm_encryption_key", Fernet.generate_key().decode())
    client.put("/api/model-settings", json=MODEL | {"allow_note_search": True})
    _, token = invite(client)
    assert signup(client, token).status_code == 201
    client.put("/api/model-settings", json=MODEL | {"allow_note_search": False})
    assert not client.get("/api/model-settings").json()["allow_note_search"]
    with patch("app.note_search.request_model") as model:
        client.post("/api/notes/search", json={"query": "floor"})
    model.assert_not_called()
    login_admin(client)
    assert client.get("/api/model-settings").json()["allow_note_search"]


def test_migration_preserves_existing_preferences_and_notes_without_granting_consent(tmp_path, monkeypatch):
    monkeypatch.setattr(settings(), "admin_password_hash", password_hash("test-password-long"))
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "migrations"))
    engine = create_engine(f"sqlite:///{tmp_path}/preferences.db")
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, "0004")
        owner = connection.scalar(select(User.id))
        connection.execute(
            text(
                "INSERT INTO model_preferences (user_id, provider, model, encrypted_key, enabled, allow_images) "
                "VALUES (:owner, 'openai', 'existing-model', 'existing-encrypted-key', true, true)"
            ),
            {"owner": owner},
        )
        connection.execute(
            Note.__table__.insert().values(
                id="preserved-note",
                user_id=owner,
                title="Floor",
                body="12500 mm",
                search_text="floor 12500 mm",
            )
        )
        command.upgrade(config, "head")
        row = connection.execute(select(ModelPreference)).mappings().one()
        assert row["enabled"] and row["allow_images"] and not row["allow_note_search"]
        assert row["model"] == "existing-model" and row["encrypted_key"] == "existing-encrypted-key"
        assert connection.scalar(select(Note.body)) == "12500 mm"
        command.downgrade(config, "0004")
        assert (
            connection.scalar(text("SELECT encrypted_key FROM model_preferences")) == "existing-encrypted-key"
        )
        command.upgrade(config, "head")
        assert connection.scalar(select(ModelPreference.allow_note_search)) is False
    engine.dispose()
