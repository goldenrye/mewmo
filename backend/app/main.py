import hashlib
import re
import threading
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import date
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import delete, select, text
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from .auth import issue_session, require_owner, verify_password
from .config import settings
from .database import session
from .models import AuthSession, Delivery, Device, Item, Reminder, now
from .parsing import ParseFailure, extract_file, parse_bill, parse_text
from .push import valid_web_endpoint
from .reminders import reconcile
from .schemas import Draft, ItemInput, LoginInput, ParseRequest, StateInput, default_rules


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not re.fullmatch(r"scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}", settings().owner_password_hash):
        raise RuntimeError("OWNER_PASSWORD_HASH must be configured; run scripts/hash_password.py")
    yield


app = FastAPI(title="Mewmo", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings().origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Content-Type", "Authorization", "X-Client-Date", "X-Client-Timezone"],
)
attempts = defaultdict(deque)
attempts_lock = threading.Lock()
ocr_slots = threading.BoundedSemaphore(2)


@app.middleware("http")
async def security(request: Request, call_next):
    origin = request.headers.get("origin")
    if request.method not in ("GET", "HEAD", "OPTIONS") and origin and origin not in settings().origins:
        return Response(status_code=403)
    length = request.headers.get("content-length", "0")
    if length.isdigit() and int(length) > 12 * 1024 * 1024:
        return Response("Upload limit is 12 MB", status_code=413)
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.get("/api/health")
def health(db: Session = Depends(session)):
    db.execute(text("SELECT 1"))
    return {"status": "ok"}


@app.post("/api/auth/login")
def login(body: LoginInput, request: Request, response: Response, db: Session = Depends(session)):
    # A global single-owner bucket avoids trusting spoofable proxy IP headers.
    with attempts_lock:
        bucket = attempts["owner"]
        while bucket and bucket[0] < time.monotonic() - 300:
            bucket.popleft()
        if len(bucket) >= 10:
            raise HTTPException(429, "Too many attempts. Try again in five minutes.")
        bucket.append(time.monotonic())
    if not verify_password(body.password):
        raise HTTPException(401, "Incorrect password")
    with attempts_lock:
        attempts["owner"].clear()
    db.execute(delete(AuthSession).where(AuthSession.expires_at <= now()))
    token = issue_session(db)
    response.set_cookie(
        "mewmo_session",
        token,
        httponly=True,
        secure=settings().cookie_secure,
        samesite="strict",
        max_age=7 * 86400,
        path="/api",
    )
    return {"ok": True, "token": token if request.headers.get("origin") == "capacitor://localhost" else None}


router = APIRouter(prefix="/api", dependencies=[Depends(require_owner)])


@router.get("/auth/me")
def me():
    return {"owner": "You", "vapid_public_key": settings().vapid_public_key}


@router.post("/auth/logout")
def logout(response: Response, auth: AuthSession = Depends(require_owner), db: Session = Depends(session)):
    db.delete(auth)
    db.commit()
    response.delete_cookie("mewmo_session", path="/api", secure=settings().cookie_secure, samesite="strict")
    return {"ok": True}


def item_json(item: Item) -> dict:
    local = item.due_at.astimezone(ZoneInfo(item.timezone))
    return {
        key: getattr(item, key)
        for key in (
            "id",
            "kind",
            "title",
            "payee",
            "amount",
            "currency",
            "account_last4",
            "timezone",
            "status",
            "rules",
            "created_at",
            "updated_at",
            "finished_at",
        )
    } | {"due_at": item.due_at, "due_date": local.date(), "due_time": local.strftime("%H:%M")}


def locked_item(db: Session, item_id: str) -> Item:
    item = db.scalar(select(Item).where(Item.id == item_id, Item.status != "deleted").with_for_update())
    if not item:
        raise HTTPException(404, "Item not found")
    return item


def duplicates(db: Session, draft: Draft) -> Draft:
    if draft.kind == "bill" and draft.amount is not None:
        candidates = db.scalars(
            select(Item).where(Item.kind == "bill", Item.status != "deleted", Item.amount == draft.amount)
        ).all()
        for item in candidates:
            same_payee = bool(draft.payee and item.payee and draft.payee.casefold() == item.payee.casefold())
            same_day = bool(
                draft.due_date and item.due_at.astimezone(ZoneInfo(item.timezone)).date() == draft.due_date
            )
            same_currency = not draft.currency or draft.currency == item.currency
            if same_currency and (same_payee or same_day):
                draft.duplicates.append(item.id)
        if draft.duplicates:
            draft.warnings.append(
                "Possible duplicate: an existing bill has a matching amount and payee or due date."
            )
    return draft


@router.post("/drafts/text", response_model=Draft)
def text_draft(body: ParseRequest, db: Session = Depends(session)):
    return duplicates(db, parse_text(body))


@router.post("/drafts/file", response_model=Draft)
async def file_draft(request: Request, local_date: date, timezone: str, db: Session = Depends(session)):
    try:
        context = ParseRequest(text="file", local_date=local_date, timezone=timezone)
    except ValidationError:
        raise HTTPException(422, "Use a valid local date and IANA time zone")
    if not ocr_slots.acquire(blocking=False):
        raise HTTPException(429, "Two imports are already being parsed. Please try again shortly.")
    try:
        data = bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data) > 12 * 1024 * 1024:
                raise HTTPException(413, "Files must be no larger than 12 MB.")
        extracted = await run_in_threadpool(extract_file, bytes(data))
        data.clear()
        draft = parse_bill(extracted, context)
        return duplicates(db, draft)
    except ParseFailure as error:
        raise HTTPException(422, str(error))
    finally:
        ocr_slots.release()


@router.get("/items")
def items(history: bool = False, db: Session = Depends(session)):
    query = select(Item).where(Item.status.in_(["paid", "completed"]) if history else Item.status == "open")
    query = query.order_by(Item.finished_at.desc()) if history else query.order_by(Item.due_at)
    return [item_json(item) for item in db.scalars(query).all()]


def apply_input(item: Item, body: ItemInput):
    for field in ("kind", "title", "payee", "amount", "currency", "account_last4", "timezone", "status"):
        setattr(item, field, getattr(body, field))
    item.due_at = body.due_at()
    item.rules = [
        r.model_dump() for r in (body.rules if body.rules is not None else default_rules(body.kind))
    ]
    item.finished_at = now() if item.status != "open" else None


@router.post("/items", status_code=201)
def create_item(body: ItemInput, db: Session = Depends(session)):
    item = Item()
    apply_input(item, body)
    db.add(item)
    db.flush()
    reconcile(db, item)
    db.commit()
    return item_json(item)


@router.put("/items/{item_id}")
def update_item(item_id: str, body: ItemInput, db: Session = Depends(session)):
    item = locked_item(db, item_id)
    apply_input(item, body)
    reconcile(db, item)
    db.commit()
    return item_json(item)


@router.post("/items/{item_id}/state")
def change_state(item_id: str, body: StateInput, db: Session = Depends(session)):
    item = locked_item(db, item_id)
    if (body.status == "paid" and item.kind != "bill") or (
        body.status == "completed" and item.kind == "bill"
    ):
        raise HTTPException(422, "Bills are paid; other items are completed.")
    item.status = body.status
    item.finished_at = now() if item.status != "open" else None
    reconcile(db, item)
    db.commit()
    return item_json(item)


@router.delete("/items/{item_id}", status_code=204)
def delete_item(item_id: str, db: Session = Depends(session)):
    item = locked_item(db, item_id)
    item.status = "deleted"
    reconcile(db, item)
    # Keep delivery audit rows but remove the deleted item's personal details.
    item.title, item.payee, item.amount, item.currency, item.account_last4 = (
        "Deleted item",
        None,
        None,
        None,
        None,
    )
    db.commit()


@router.get("/items/{item_id}/reminders")
def item_reminders(item_id: str, db: Session = Depends(session)):
    item = db.get(Item, item_id)
    if not item or item.status == "deleted":
        raise HTTPException(404, "Item not found")
    rows = db.scalars(select(Reminder).where(Reminder.item_id == item_id).order_by(Reminder.fire_at)).all()
    return [
        {
            key: getattr(row, key)
            for key in ("id", "fire_at", "rule_key", "status", "attempts", "sent_at", "error")
        }
        | {
            "deliveries": [
                {
                    "platform": device.platform,
                    "status": delivery.status,
                    "error": delivery.error,
                    "accepted_at": delivery.accepted_at,
                }
                for delivery, device in db.execute(
                    select(Delivery, Device)
                    .join(Device, Device.id == Delivery.device_id)
                    .where(Delivery.reminder_id == row.id)
                ).all()
            ]
        }
        for row in rows
    ]


class DeviceInput(BaseModel):
    platform: str = Field(pattern=r"^(ios|web)$")
    token: str | None = Field(default=None, max_length=512)
    subscription: dict | None = None


@router.post("/devices")
def register_device(body: DeviceInput, db: Session = Depends(session)):
    if body.platform == "ios":
        if not body.token or not re.fullmatch(r"[0-9a-fA-F]{64,256}", body.token):
            raise HTTPException(422, "Invalid APNs device token")
        value, subscription = body.token, {"token": body.token}
    else:
        sub = body.subscription or {}
        value = sub.get("endpoint", "")
        keys = sub.get("keys", {})
        if not isinstance(value, str) or not valid_web_endpoint(value) or len(value) > 2000:
            raise HTTPException(422, "Unsupported web push endpoint")
        if not isinstance(keys, dict) or not all(
            isinstance(keys.get(k), str) and re.fullmatch(r"[A-Za-z0-9_=-]{16,256}", keys[k])
            for k in ("auth", "p256dh")
        ):
            raise HTTPException(422, "Invalid web push keys")
        subscription = {"endpoint": value, "keys": {k: keys[k] for k in ("auth", "p256dh")}}
    digest = hashlib.sha256(value.encode()).hexdigest()
    device = db.scalar(select(Device).where(Device.endpoint_hash == digest))
    if not device:
        device = Device(platform=body.platform, endpoint_hash=digest, subscription=subscription)
        db.add(device)
    device.subscription, device.active = subscription, True
    db.commit()
    return {"id": device.id}


@router.get("/devices")
def devices(db: Session = Depends(session)):
    return [
        {"id": d.id, "platform": d.platform, "active": d.active} for d in db.scalars(select(Device)).all()
    ]


@router.delete("/devices/{device_id}", status_code=204)
def disable_device(device_id: str, db: Session = Depends(session)):
    device = db.get(Device, device_id)
    if not device:
        raise HTTPException(404, "Device not found")
    device.active = False
    db.commit()


app.include_router(router)
