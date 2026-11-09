import hashlib
import re
import threading
from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from .accounts import router as accounts_router
from .ai_assistance import AI_FAILURE, assist_draft
from .auth import client_key_hash, require_user
from .config import settings
from .database import session
from .file_reminders import parse_file
from .model_settings import image_chain_token
from .model_settings import router as model_settings_router
from .models import Delivery, Device, Item, ModelPreference, Reminder, User, now
from .notes import router as notes_router
from .parsing import ParseFailure, extract_file, parse_text
from .push import valid_web_endpoint
from .reminders import reconcile
from .schemas import Draft, ItemInput, ParseRequest, StateInput, default_rules

app = FastAPI(title="Mewmo")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings().origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=[
        "Content-Type",
        "Authorization",
        "X-Client-Date",
        "X-Client-Timezone",
        "X-Client-Key",
        "X-Account-ID",
    ],
)
ocr_slots = threading.BoundedSemaphore(2)


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, error: RequestValidationError):
    errors = error.errors()
    if request.url.path == "/api/auth/login" and any(
        e["type"] == "missing" and tuple(e["loc"]) == ("body", "username") for e in errors
    ):
        return JSONResponse(
            status_code=422,
            content={
                "detail": (
                    "Username is required. If your sign-in screen only asks for a password, "
                    "update the Mewmo iPhone app or reload the website, then sign in "
                    "with your username and password."
                )
            },
        )
    # Pydantic's input/context fields can contain passwords or invitation tokens.
    return JSONResponse(
        status_code=422,
        content={"detail": [{key: e[key] for key in ("type", "loc", "msg")} for e in errors]},
    )


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
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@app.get("/api/health")
def health(db: Session = Depends(session)):
    db.execute(text("SELECT 1"))
    return {"status": "ok"}


router = APIRouter(prefix="/api", dependencies=[Depends(require_user)])


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


def locked_item(db: Session, item_id: str, user_id: str) -> Item:
    item = db.scalar(
        select(Item)
        .where(
            Item.id == item_id,
            Item.user_id == user_id,
            Item.status != "deleted",
        )
        .with_for_update()
    )
    if not item:
        raise HTTPException(404, "Item not found")
    return item


def duplicates(db: Session, draft: Draft, user_id: str) -> Draft:
    if draft.kind == "bill" and draft.amount is not None:
        candidates = db.scalars(
            select(Item).where(
                Item.user_id == user_id,
                Item.kind == "bill",
                Item.status != "deleted",
                Item.amount == draft.amount,
            )
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
def text_draft(body: ParseRequest, db: Session = Depends(session), user: User = Depends(require_user)):
    if body.client_now is None:
        # Older clients send only a date; use one server instant for the whole parse.
        body = body.model_copy(update={"client_now": datetime.now(UTC)})
    preference = db.get(ModelPreference, user.id)
    draft = assist_draft(preference, body, body.text)
    if draft is None:
        draft = parse_text(body)
        if preference and preference.enabled:
            draft.warnings.append(AI_FAILURE)
    return duplicates(db, draft, user.id)


@router.post("/drafts/file", response_model=Draft)
async def file_draft(
    request: Request,
    local_date: date,
    timezone: str,
    use_image_ai: bool = False,
    image_provider: str | None = None,
    image_revision: int | None = None,
    image_chain: str | None = None,
    db: Session = Depends(session),
    user: User = Depends(require_user),
):
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
        preference = db.get(ModelPreference, user.id)
        if use_image_ai and not (preference and preference.enabled and preference.allow_images):
            raise HTTPException(400, "Enable image analysis in AI settings before using it for an import.")
        if use_image_ai and image_provider != preference.provider:
            raise HTTPException(400, "AI settings changed. Review them and opt in to image analysis again.")
        if use_image_ai and (
            (preference.fallbacks and image_chain != image_chain_token(preference))
            or (image_chain is not None and image_chain != image_chain_token(preference))
            or (image_revision is not None and image_revision != preference.revision)
        ):
            raise HTTPException(400, "AI settings changed. Review them and opt in to image analysis again.")
        image_data = bytes(data) if use_image_ai else None
        extracted, draft, failure = "", None, None
        try:
            extracted = await run_in_threadpool(extract_file, bytes(data))
        except ParseFailure as error:
            failure = error
        data.clear()
        if extracted or image_data:
            draft = await run_in_threadpool(
                assist_draft,
                preference,
                context,
                extracted,
                image_data,
                source="file",
            )
        if draft is None and extracted:
            try:
                draft = await run_in_threadpool(parse_file, extracted, context)
                if preference and preference.enabled:
                    draft.warnings.append(AI_FAILURE)
                    if image_data:
                        draft.warnings.append(
                            "Image analysis did not produce a usable draft. Images may have been sent to your configured providers."
                        )
            except ParseFailure as error:
                failure = error
        if draft is None:
            raise failure or ParseFailure(
                "We could not read this file. Try a clearer image or enter it manually."
            )
        if (
            "Review every field. OCR can make mistakes. The original file has been discarded."
            not in draft.warnings
        ):
            draft.warnings.append(
                "Review every field. OCR can make mistakes. The original file has been discarded."
            )
        return duplicates(db, draft, user.id)
    except ParseFailure as error:
        raise HTTPException(422, str(error))
    finally:
        ocr_slots.release()


@router.get("/items")
def items(history: bool = False, db: Session = Depends(session), user: User = Depends(require_user)):
    query = select(Item).where(
        Item.user_id == user.id,
        Item.status.in_(["paid", "completed"]) if history else Item.status == "open",
    )
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
def create_item(body: ItemInput, db: Session = Depends(session), user: User = Depends(require_user)):
    item = Item(user_id=user.id)
    apply_input(item, body)
    db.add(item)
    db.flush()
    reconcile(db, item)
    db.commit()
    return item_json(item)


@router.put("/items/{item_id}")
def update_item(
    item_id: str,
    body: ItemInput,
    db: Session = Depends(session),
    user: User = Depends(require_user),
):
    item = locked_item(db, item_id, user.id)
    apply_input(item, body)
    reconcile(db, item)
    db.commit()
    return item_json(item)


@router.post("/items/{item_id}/state")
def change_state(
    item_id: str,
    body: StateInput,
    db: Session = Depends(session),
    user: User = Depends(require_user),
):
    item = locked_item(db, item_id, user.id)
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
def delete_item(item_id: str, db: Session = Depends(session), user: User = Depends(require_user)):
    item = locked_item(db, item_id, user.id)
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
def item_reminders(item_id: str, db: Session = Depends(session), user: User = Depends(require_user)):
    item = db.scalar(select(Item).where(Item.id == item_id, Item.user_id == user.id))
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
                    .where(Delivery.reminder_id == row.id, Device.user_id == user.id)
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
def register_device(
    body: DeviceInput,
    request: Request,
    db: Session = Depends(session),
    user: User = Depends(require_user),
):
    key = client_key_hash(request)
    if not key:
        raise HTTPException(422, "A valid X-Client-Key installation identifier is required")
    if body.platform == "ios":
        if not body.token or not re.fullmatch(r"[0-9a-fA-F]{64,256}", body.token):
            raise HTTPException(422, "Invalid APNs device token")
        value = body.token.lower()
        subscription = {"token": value}
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
    device = db.scalar(
        select(Device)
        .where(Device.endpoint_hash == digest)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if device and device.user_id != user.id:
        # Preserve the old owner's delivery audit without moving it to the new account.
        device.active, device.endpoint_hash, device.subscription = False, None, {}
        db.flush()
        device = None
    if not device:
        device = Device(
            user_id=user.id,
            platform=body.platform,
            endpoint_hash=digest,
            subscription=subscription,
        )
        db.add(device)
    device.subscription, device.active, device.client_key_hash = subscription, True, key
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Device registration changed. Please retry.")
    return {"id": device.id}


@router.get("/devices")
def devices(db: Session = Depends(session), user: User = Depends(require_user)):
    return [
        {"id": d.id, "platform": d.platform, "active": d.active}
        for d in db.scalars(select(Device).where(Device.user_id == user.id)).all()
    ]


@router.delete("/devices/{device_id}", status_code=204)
def disable_device(device_id: str, db: Session = Depends(session), user: User = Depends(require_user)):
    device = db.scalar(
        select(Device)
        .where(
            Device.id == device_id,
            Device.user_id == user.id,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if not device:
        raise HTTPException(404, "Device not found")
    device.active = False
    db.commit()


app.include_router(router)
app.include_router(accounts_router)
app.include_router(model_settings_router)
app.include_router(notes_router)
