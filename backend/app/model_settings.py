import hashlib
import json
import time
from typing import Literal

from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from .accounts import throttle
from .auth import require_user
from .config import settings
from .database import session
from .model_provider import ModelUnavailable, request_model
from .models import ModelFallback, ModelPreference, User, new_id

router = APIRouter(prefix="/api/model-settings")
SETUP_ERROR = "AI settings are unavailable. Ask the server administrator to configure encryption."
KEY_ERROR = "Enter an API key for this provider."
TEST_ERROR = "Could not connect to the model. Check the provider, model ID, API key, and available credit."
STALE_ERROR = "AI settings changed on another device. Reload settings before saving."


class ModelCredentialsInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider: Literal["openai", "anthropic", "gemini", "doubao"]
    model: str = Field(min_length=1, max_length=120, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
    api_key: SecretStr | None = Field(default=None, min_length=1, max_length=2048)

    @field_validator("api_key")
    @classmethod
    def valid_key(cls, value):
        if value and any(ord(char) < 33 or ord(char) > 126 for char in value.get_secret_value()):
            raise ValueError("API key must not contain spaces or control characters.")
        return value


class ModelSettingsInput(ModelCredentialsInput):
    enabled: bool = False
    allow_images: bool = False
    allow_note_search: bool | None = None


class ModelEntryInput(ModelCredentialsInput):
    id: str | None = Field(default=None, max_length=36)


class ModelListInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    models: list[ModelEntryInput] = Field(min_length=1, max_length=5)
    revision: int = Field(ge=0)
    enabled: bool = False
    allow_images: bool = False
    allow_note_search: bool = False


def ordered_models(row: ModelPreference):
    return [row, *row.fallbacks]


def model_id(model: ModelPreference | ModelFallback):
    return "primary" if isinstance(model, ModelPreference) else model.id


def image_chain_token(row: ModelPreference):
    # Bind image consent to the exact ordered configuration, including key changes.
    values = [(model.provider, model.model, model.encrypted_key) for model in ordered_models(row)]
    return hashlib.sha256(json.dumps([row.revision, values]).encode()).hexdigest()


def encrypt_key(user_id: str, provider: str, key: str):
    payload = json.dumps({"user_id": user_id, "provider": provider, "key": key}).encode()
    return cipher().encrypt(payload).decode("ascii")


def next_revision(row: ModelPreference):
    # Stay JSON-safe while avoiding revision reuse after deleting/recreating settings.
    return max(time.time_ns() // 1000, (row.revision or 0) + 1)


def cipher() -> Fernet:
    try:
        return Fernet(settings().llm_encryption_key.encode("ascii"))
    except (ValueError, UnicodeError):
        raise ModelUnavailable() from None


def encryption_ready() -> bool:
    try:
        cipher()
        return True
    except ModelUnavailable:
        return False


def decrypt_key(row: ModelPreference | ModelFallback) -> str:
    try:
        value = json.loads(cipher().decrypt(row.encrypted_key.encode("ascii")))
        if value["user_id"] != row.user_id or value["provider"] != row.provider:
            raise ModelUnavailable()
        return value["key"]
    except (InvalidToken, ValueError, KeyError, TypeError, UnicodeError):
        raise ModelUnavailable() from None


def preference_json(row: ModelPreference | None):
    return {
        "available": encryption_ready(),
        "provider": row.provider if row else "openai",
        "model": row.model if row else "",
        "has_key": bool(row),
        "enabled": row.enabled if row else False,
        "allow_images": row.allow_images if row else False,
        "allow_note_search": row.allow_note_search if row else True,
        "revision": row.revision if row else 0,
        "image_chain_token": image_chain_token(row) if row else None,
        "models": [
            {"id": model_id(model), "provider": model.provider, "model": model.model, "has_key": True}
            for model in ordered_models(row)
        ]
        if row
        else [],
    }


@router.get("")
def get_preferences(user: User = Depends(require_user), db: Session = Depends(session)):
    return preference_json(db.get(ModelPreference, user.id))


@router.put("")
def save_preferences(
    body: ModelSettingsInput, user: User = Depends(require_user), db: Session = Depends(session)
):
    if not encryption_ready():
        raise HTTPException(503, SETUP_ERROR)
    # Serialize first-time saves as well as changes, without accepting a target user ID.
    db.scalar(select(User).where(User.id == user.id).with_for_update())
    row = db.get(ModelPreference, user.id)
    if row and row.fallbacks:
        raise HTTPException(409, "Use the updated app to edit your ordered AI models.")
    if not body.api_key and (not row or row.provider != body.provider):
        raise HTTPException(400, KEY_ERROR)
    if not row:
        row = ModelPreference(user_id=user.id)
        db.add(row)
    if body.api_key:
        row.encrypted_key = encrypt_key(user.id, body.provider, body.api_key.get_secret_value())
    row.provider, row.model = body.provider, body.model
    row.enabled, row.allow_images = body.enabled, body.allow_images
    # Older clients do not send this field; never grant new consent implicitly.
    if body.allow_note_search is not None:
        row.allow_note_search = body.allow_note_search
    row.revision = next_revision(row)
    db.commit()
    return preference_json(row)


@router.put("/models")
def save_model_list(body: ModelListInput, user: User = Depends(require_user), db: Session = Depends(session)):
    if not encryption_ready():
        raise HTTPException(503, SETUP_ERROR)
    db.scalar(select(User).where(User.id == user.id).with_for_update())
    row = db.scalar(
        select(ModelPreference)
        .where(ModelPreference.user_id == user.id)
        .execution_options(populate_existing=True)
    )
    if body.revision != (row.revision if row else 0):
        raise HTTPException(409, STALE_ERROR)
    existing = {model_id(model): model for model in ordered_models(row)} if row else {}
    seen = set()
    values = []
    for entry in body.models:
        if entry.id is not None and (entry.id not in existing or entry.id in seen):
            raise HTTPException(400, "Invalid or repeated model ID.")
        seen.add(entry.id)
        previous = existing.get(entry.id)
        if entry.api_key:
            encrypted = encrypt_key(user.id, entry.provider, entry.api_key.get_secret_value())
        elif previous and previous.provider == entry.provider:
            encrypted = previous.encrypted_key
        else:
            raise HTTPException(400, KEY_ERROR)
        values.append({"provider": entry.provider, "model": entry.model, "encrypted_key": encrypted})
    if row is None:
        row = ModelPreference(user_id=user.id)
        db.add(row)
    else:
        row.fallbacks.clear()
        db.flush()
    row.provider = values[0]["provider"]
    row.model = values[0]["model"]
    row.encrypted_key = values[0]["encrypted_key"]
    row.enabled, row.allow_images, row.allow_note_search = (
        body.enabled,
        body.allow_images,
        body.allow_note_search,
    )
    row.revision = next_revision(row)
    row.fallbacks = [
        ModelFallback(
            id=entry.id if entry.id and entry.id != "primary" else new_id(),
            user_id=user.id,
            position=index,
            **value,
        )
        for index, (entry, value) in enumerate(zip(body.models[1:], values[1:]), start=1)
    ]
    db.commit()
    return preference_json(row)


@router.delete("", status_code=204)
def delete_preferences(
    revision: int | None = None, user: User = Depends(require_user), db: Session = Depends(session)
):
    db.scalar(select(User).where(User.id == user.id).with_for_update())
    row = db.get(ModelPreference, user.id)
    if row:
        if row.fallbacks and revision is None:
            raise HTTPException(409, "Use the updated app to edit your ordered AI models.")
        if revision is not None and revision != row.revision:
            raise HTTPException(409, STALE_ERROR)
        db.delete(row)
        db.commit()


@router.post("/test")
def test_preferences(
    model_id: str = "primary", user: User = Depends(require_user), db: Session = Depends(session)
):
    throttle("model-test:" + user.id, 5)
    row = db.get(ModelPreference, user.id)
    if not row:
        raise HTTPException(400, KEY_ERROR)
    model = (
        row
        if model_id == "primary"
        else next((entry for entry in row.fallbacks if entry.id == model_id), None)
    )
    if model is None:
        raise HTTPException(404, "Model not found")
    try:
        result = request_model(
            model.provider,
            model.model,
            decrypt_key(model),
            'Return only the JSON object {"ok": true}.',
            "Connection test. No customer data is included.",
        )
        if json.loads(result) != {"ok": True}:
            raise ModelUnavailable()
    except (ModelUnavailable, ValueError):
        raise HTTPException(400, TEST_ERROR) from None
    return {"ok": True}
