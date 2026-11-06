import secrets
import threading
import time
from collections import OrderedDict, deque
from datetime import timedelta
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .auth import (
    DUMMY_PASSWORD_HASH,
    disable_installation,
    issue_session,
    password_hash,
    require_admin,
    require_session,
    require_user,
    token_hash,
    verify_password,
)
from .config import settings
from .database import session
from .models import AuthSession, Invitation, User, now
from .schemas import LoginInput, PasswordInput, RegisterInput

router = APIRouter(prefix="/api")
attempts: OrderedDict[str, deque] = OrderedDict()
attempts_lock = threading.Lock()


def throttle(key: str, limit: int = 10):
    with attempts_lock:
        stamp = time.monotonic()
        bucket = attempts.setdefault(key, deque())
        attempts.move_to_end(key)
        while bucket and bucket[0] <= stamp - 300:
            bucket.popleft()
        if len(bucket) >= limit:
            raise HTTPException(429, "Too many attempts. Try again in five minutes.")
        bucket.append(stamp)
        while len(attempts) > 2048:
            attempts.popitem(last=False)


def user_json(user: User):
    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "is_admin": user.is_admin,
    }


def signed_in(db: Session, user: User, request: Request, response: Response):
    # Switching accounts on an installation detaches its previous notification owner.
    disable_installation(db, request)
    db.execute(delete(AuthSession).where(AuthSession.expires_at <= now()))
    token = issue_session(db, user.id)
    db.commit()
    response.set_cookie(
        "mewmo_session",
        token,
        httponly=True,
        secure=settings().cookie_secure,
        samesite="strict",
        max_age=7 * 86400,
        path="/api",
    )
    return {
        "user": user_json(user),
        "token": token if request.headers.get("origin") == "capacitor://localhost" else None,
        "vapid_public_key": settings().vapid_public_key,
    }


@router.post("/auth/login")
def login(body: LoginInput, request: Request, response: Response, db: Session = Depends(session)):
    throttle("login:global", 300)
    throttle("login:" + token_hash(body.username))
    user = db.scalar(select(User).where(User.username == body.username))
    valid = verify_password(body.password, user.password_hash if user else DUMMY_PASSWORD_HASH)
    if not valid or not user:
        raise HTTPException(401, "Incorrect username or password")
    with attempts_lock:
        attempts.pop("login:" + token_hash(body.username), None)
    return signed_in(db, user, request, response)


@router.post("/auth/register", status_code=201)
def register(body: RegisterInput, request: Request, response: Response, db: Session = Depends(session)):
    throttle("register:global", 100)
    throttle("register:" + token_hash(body.invite_token))
    hashed_password = password_hash(body.password)
    invitation = db.scalar(
        select(Invitation)
        .where(Invitation.token_hash == token_hash(body.invite_token))
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    stamp = now()
    if not invitation or invitation.used_at or invitation.revoked_at or invitation.expires_at <= stamp:
        raise HTTPException(400, "This invitation is invalid, expired, revoked, or already used.")
    user = User(
        username=body.username,
        display_name=body.display_name,
        password_hash=hashed_password,
        is_admin=False,
    )
    db.add(user)
    try:
        db.flush()
        invitation.used_by, invitation.used_at = user.id, stamp
        return signed_in(db, user, request, response)
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "That username is unavailable. Choose another.")


@router.get("/auth/me")
def me(user: User = Depends(require_user)):
    return {"user": user_json(user), "vapid_public_key": settings().vapid_public_key}


@router.post("/auth/logout")
def logout(
    request: Request,
    response: Response,
    auth: AuthSession = Depends(require_session),
    db: Session = Depends(session),
):
    disable_installation(db, request, auth.user_id)
    db.delete(auth)
    db.commit()
    response.delete_cookie("mewmo_session", path="/api", secure=settings().cookie_secure, samesite="strict")
    return {"ok": True}


@router.post("/auth/password")
def change_password(
    body: PasswordInput,
    auth: AuthSession = Depends(require_session),
    db: Session = Depends(session),
):
    throttle("password:" + auth.user_id)
    user = db.scalar(select(User).where(User.id == auth.user_id).with_for_update())
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(400, "Current password is incorrect")
    user.password_hash = password_hash(body.new_password)
    db.execute(
        delete(AuthSession).where(
            AuthSession.user_id == user.id,
            AuthSession.token_hash != auth.token_hash,
        )
    )
    db.commit()
    return {"ok": True}


def invitation_json(invitation: Invitation):
    status = (
        "used"
        if invitation.used_at
        else "revoked"
        if invitation.revoked_at
        else "expired"
        if invitation.expires_at <= now()
        else "pending"
    )
    return {
        "id": invitation.id,
        "created_at": invitation.created_at,
        "expires_at": invitation.expires_at,
        "status": status,
    }


def invitation_base_url():
    value = settings().public_web_url.rstrip("/")
    parsed = urlsplit(value)
    local = parsed.hostname in ("localhost", "127.0.0.1") and not settings().cookie_secure
    if (
        not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/")
        or parsed.scheme not in ("http", "https")
        or (parsed.scheme != "https" and not local)
    ):
        raise HTTPException(503, "Set PUBLIC_WEB_URL to Mewmo's public HTTPS origin before inviting users.")
    return value


@router.post("/admin/invitations", status_code=201)
def create_invitation(admin: User = Depends(require_admin), db: Session = Depends(session)):
    base = invitation_base_url()
    throttle("invite:" + admin.id, 30)
    token = secrets.token_urlsafe(32)
    stamp = now()
    invitation = Invitation(
        token_hash=token_hash(token),
        created_by=admin.id,
        created_at=stamp,
        expires_at=stamp + timedelta(days=7),
    )
    db.add(invitation)
    db.commit()
    # Fragments are not sent in HTTP requests or Referer headers.
    return invitation_json(invitation) | {"url": f"{base}/#invite={token}"}


@router.get("/admin/invitations")
def invitations(admin: User = Depends(require_admin), db: Session = Depends(session)):
    rows = db.scalars(select(Invitation).order_by(Invitation.created_at.desc()).limit(100)).all()
    return [invitation_json(row) for row in rows]


@router.delete("/admin/invitations/{invitation_id}", status_code=204)
def revoke_invitation(
    invitation_id: str,
    admin: User = Depends(require_admin),
    db: Session = Depends(session),
):
    invitation = db.scalar(
        select(Invitation)
        .where(Invitation.id == invitation_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if not invitation:
        raise HTTPException(404, "Invitation not found")
    if invitation.used_at:
        raise HTTPException(409, "This invitation has already been used")
    invitation.revoked_at = now()
    db.commit()
