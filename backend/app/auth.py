import hashlib
import hmac
import secrets
from datetime import timedelta

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from .config import settings
from .database import session
from .models import AuthSession, now


def password_hash(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1).hex()
    return f"scrypt${salt}${digest}"


def verify_password(password: str) -> bool:
    stored = settings().owner_password_hash
    try:
        _, salt, _ = stored.split("$")
        return hmac.compare_digest(password_hash(password, salt), stored)
    except ValueError:
        return False


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def request_token(request: Request) -> str:
    bearer = request.headers.get("authorization", "")
    return bearer[7:] if bearer.startswith("Bearer ") else request.cookies.get("mewmo_session", "")


def require_owner(request: Request, db: Session = Depends(session)):
    token = request_token(request)
    auth = db.get(AuthSession, token_hash(token)) if token else None
    if not auth or auth.expires_at <= now():
        raise HTTPException(401, "Please sign in")
    return auth


def issue_session(db: Session) -> str:
    token = secrets.token_urlsafe(48)
    db.add(AuthSession(token_hash=token_hash(token), expires_at=now() + timedelta(days=7)))
    db.commit()
    return token
