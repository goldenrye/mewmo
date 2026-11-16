import re
import secrets
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from starlette.datastructures import Headers

from .accounts import invitation_base_url, throttle
from .auth import require_user, token_hash
from .database import session
from .models import AgentToken, User, now

router = APIRouter(prefix="/api/agent-tokens")


def api_key_hash(value: str) -> str | None:
    if not re.fullmatch(r"mewmo_mcp_[A-Za-z0-9_-]{64}", value):
        return None
    return token_hash(value)


def bearer_hash(authorization: str) -> str | None:
    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return api_key_hash(parts[1])


def credential_hash(headers: Headers) -> str | None:
    authorization = headers.getlist("authorization")
    api_keys = headers.getlist("x-api-key")
    # Never select an arbitrary first credential or fall back from an invalid one.
    if len(authorization) > 1 or len(api_keys) > 1:
        return None
    digests = []
    if authorization:
        digests.append(bearer_hash(authorization[0]))
    if api_keys:
        digests.append(api_key_hash(api_keys[0].strip()))
    if not digests or any(digest is None for digest in digests):
        return None
    if len(digests) == 2 and not secrets.compare_digest(digests[0], digests[1]):
        return None
    return digests[0]


def agent_token(db: Session, digest: str | None, lock: bool = False) -> AgentToken:
    query = select(AgentToken).where(AgentToken.token_hash == digest)
    if lock:
        query = query.with_for_update()
    token = db.scalar(query.execution_options(populate_existing=True)) if digest else None
    if not token or token.revoked_at or token.expires_at <= now():
        raise HTTPException(401, "Agent token is missing, expired, or revoked.")
    if not db.get(User, token.user_id):
        raise HTTPException(401, "Agent account is unavailable.")
    return token


def token_json(token: AgentToken):
    return {
        "id": token.id,
        "name": token.name,
        "created_at": token.created_at,
        "expires_at": token.expires_at,
        "status": "revoked" if token.revoked_at else "expired" if token.expires_at <= now() else "active",
    }


class TokenInput(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    expires_days: int = Field(default=30, ge=1, le=90, strict=True)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value):
        if not value.strip():
            raise ValueError("Enter a name for this agent")
        return value.strip()


@router.get("")
def list_tokens(user: User = Depends(require_user), db: Session = Depends(session)):
    return {
        "endpoint": invitation_base_url() + "/api/mcp/",
        "tokens": [
            token_json(token)
            for token in db.scalars(
                select(AgentToken).where(AgentToken.user_id == user.id).order_by(AgentToken.created_at.desc())
            )
        ],
    }


@router.post("", status_code=201)
def create_token(body: TokenInput, user: User = Depends(require_user), db: Session = Depends(session)):
    endpoint = invitation_base_url() + "/api/mcp/"
    throttle("agent-token:" + user.id, 20)
    db.scalar(select(User).where(User.id == user.id).with_for_update())
    count = db.scalar(
        select(func.count())
        .select_from(AgentToken)
        .where(AgentToken.user_id == user.id, AgentToken.revoked_at.is_(None), AgentToken.expires_at > now())
    )
    if count >= 10:
        raise HTTPException(409, "Revoke an active agent token before creating another (limit 10).")
    secret = "mewmo_mcp_" + secrets.token_urlsafe(48)
    token = AgentToken(
        user_id=user.id,
        name=body.name,
        token_hash=token_hash(secret),
        expires_at=now() + timedelta(days=body.expires_days),
    )
    db.add(token)
    db.commit()
    return token_json(token) | {"token": secret, "endpoint": endpoint}


@router.delete("/{token_id}", status_code=204)
def revoke_token(token_id: str, user: User = Depends(require_user), db: Session = Depends(session)):
    token = db.scalar(
        select(AgentToken).where(AgentToken.id == token_id, AgentToken.user_id == user.id).with_for_update()
    )
    if not token:
        raise HTTPException(404, "Agent token not found")
    token.revoked_at = now()
    db.commit()
