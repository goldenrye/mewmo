import json
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
from .models import ModelPreference, User

router = APIRouter(prefix="/api/model-settings")
SETUP_ERROR = "AI settings are unavailable. Ask the server administrator to configure encryption."
KEY_ERROR = "Enter an API key for this provider."
TEST_ERROR = "Could not connect to the model. Check the provider, model ID, API key, and available credit."


class ModelSettingsInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider: Literal["openai", "anthropic", "gemini"]
    model: str = Field(min_length=1, max_length=120, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
    api_key: SecretStr | None = Field(default=None, min_length=1, max_length=2048)
    enabled: bool = False
    allow_images: bool = False

    @field_validator("api_key")
    @classmethod
    def valid_key(cls, value):
        if value and any(ord(char) < 33 or ord(char) > 126 for char in value.get_secret_value()):
            raise ValueError("API key must not contain spaces or control characters.")
        return value


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


def decrypt_key(row: ModelPreference) -> str:
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
    if not body.api_key and (not row or row.provider != body.provider):
        raise HTTPException(400, KEY_ERROR)
    if not row:
        row = ModelPreference(user_id=user.id)
        db.add(row)
    if body.api_key:
        payload = json.dumps(
            {
                "user_id": user.id,
                "provider": body.provider,
                "key": body.api_key.get_secret_value(),
            }
        ).encode()
        row.encrypted_key = cipher().encrypt(payload).decode("ascii")
    row.provider, row.model = body.provider, body.model
    row.enabled, row.allow_images = body.enabled, body.allow_images
    db.commit()
    return preference_json(row)


@router.delete("", status_code=204)
def delete_preferences(user: User = Depends(require_user), db: Session = Depends(session)):
    db.scalar(select(User).where(User.id == user.id).with_for_update())
    row = db.get(ModelPreference, user.id)
    if row:
        db.delete(row)
        db.commit()


@router.post("/test")
def test_preferences(user: User = Depends(require_user), db: Session = Depends(session)):
    throttle("model-test:" + user.id, 5)
    row = db.get(ModelPreference, user.id)
    if not row:
        raise HTTPException(400, KEY_ERROR)
    try:
        result = request_model(
            row.provider,
            row.model,
            decrypt_key(row),
            'Return only the JSON object {"ok": true}.',
            "Connection test. No customer data is included.",
        )
        if json.loads(result) != {"ok": True}:
            raise ModelUnavailable()
    except (ModelUnavailable, ValueError):
        raise HTTPException(400, TEST_ERROR) from None
    return {"ok": True}
