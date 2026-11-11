import hashlib
import hmac
import re
import secrets
from datetime import timedelta

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from .database import session
from .models import AuthSession, Device, User, now

PASSWORD_PATTERN = r"scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}"


def password_hash(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1).hex()
    return f"scrypt${salt}${digest}"


# Unknown usernames still incur the same password hashing work.
DUMMY_PASSWORD_HASH = password_hash("invalid-account-password", "0" * 32)


def verify_password(password: str, stored: str) -> bool:
    if not re.fullmatch(PASSWORD_PATTERN, stored):
        return False
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


def require_session(request: Request, db: Session = Depends(session)):
    token = request_token(request)
    auth = db.get(AuthSession, token_hash(token)) if token else None
    if not auth or auth.expires_at <= now():
        raise HTTPException(401, "Please sign in")
    expected_user = request.headers.get("x-account-id")
    if expected_user and expected_user != auth.user_id:
        raise HTTPException(401, "Account changed. Please sign in again.")
    return auth


def require_user(auth: AuthSession = Depends(require_session), db: Session = Depends(session)) -> User:
    user = db.get(User, auth.user_id)
    if not user:
        raise HTTPException(401, "Please sign in")
    return user


def require_admin(user: User = Depends(require_user)) -> User:
    if not user.is_admin:
        raise HTTPException(403, "Administrator access required")
    return user


def client_key_hash(request: Request) -> str | None:
    key = request.headers.get("x-client-key", "")
    return token_hash(key) if re.fullmatch(r"[0-9a-f]{64}", key) else None


def disable_installation(db: Session, request: Request, user_id: str | None = None):
    key = client_key_hash(request)
    if not key:
        return
    query = select(Device).where(Device.client_key_hash == key).order_by(Device.id).with_for_update()
    if user_id is not None:
        query = query.where(Device.user_id == user_id)
    for device in db.scalars(query.execution_options(populate_existing=True)):
        device.active = False


def issue_session(db: Session, user_id: str) -> str:
    token = secrets.token_urlsafe(48)
    db.add(AuthSession(token_hash=token_hash(token), user_id=user_id, expires_at=now() + timedelta(days=7)))
    db.flush()
    return token
