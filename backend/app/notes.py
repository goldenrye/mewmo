from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from .auth import require_user
from .database import session
from .models import ModelPreference, Note, User
from .note_search import normalize, search_terms

router = APIRouter(prefix="/api/notes")


class NoteInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirmed: Literal[True]
    title: str = Field(min_length=1, max_length=180)
    body: str = Field(min_length=1, max_length=10000)

    @field_validator("title", "body")
    @classmethod
    def nonempty(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be empty")
        return value


class NoteUpdate(NoteInput):
    version: int = Field(ge=1)


class SearchInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: str = Field(min_length=1, max_length=500)
    # Legacy clients may still opt out per search, but cannot override settings.
    use_ai: bool | None = None
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=50, ge=1, le=50)


def note_json(note: Note):
    return {key: getattr(note, key) for key in ("id", "title", "body", "version", "created_at", "updated_at")}


def owned_note(db: Session, user_id: str, note_id: str, lock=False):
    query = select(Note).where(Note.id == note_id, Note.user_id == user_id)
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    note = db.scalar(query)
    if not note:
        raise HTTPException(404, "Note not found")
    return note


def check_version(note: Note, version: int):
    if note.version != version:
        raise HTTPException(409, "This note changed on another device. Close and reopen it before editing.")


@router.get("")
def list_notes(
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=50),
    db: Session = Depends(session),
    user: User = Depends(require_user),
):
    condition = Note.user_id == user.id
    total = db.scalar(select(func.count()).select_from(Note).where(condition))
    rows = db.scalars(
        select(Note).where(condition).order_by(Note.updated_at.desc(), Note.id).offset(offset).limit(limit)
    ).all()
    return {"items": [note_json(row) for row in rows], "total": total, "mode": "local", "warning": None}


@router.post("/search")
def find_notes(body: SearchInput, db: Session = Depends(session), user: User = Depends(require_user)):
    preference = db.get(ModelPreference, user.id)
    use_ai = bool(preference and preference.allow_note_search and body.use_ai is not False)
    terms, mode, warning = search_terms(body.query, preference, use_ai)
    if not terms:
        return {"items": [], "total": 0, "mode": mode, "warning": warning}
    # Bound parameters and escaped LIKE patterns keep dictated text literal.
    score = sum(
        case((Note.search_text.contains(term, autoescape=True), weight), else_=0)
        for term, weight in terms.items()
    )
    condition = (Note.user_id == user.id) & (score > 0)
    total = db.scalar(select(func.count()).select_from(Note).where(condition))
    rows = db.scalars(
        select(Note)
        .where(condition)
        .order_by(score.desc(), Note.updated_at.desc(), Note.id)
        .offset(body.offset)
        .limit(body.limit)
    ).all()
    return {"items": [note_json(row) for row in rows], "total": total, "mode": mode, "warning": warning}


@router.post("", status_code=201)
def create_note(body: NoteInput, db: Session = Depends(session), user: User = Depends(require_user)):
    note = Note(
        user_id=user.id,
        title=body.title,
        body=body.body,
        search_text=normalize(body.title + "\n" + body.body),
    )
    db.add(note)
    db.commit()
    return note_json(note)


@router.get("/{note_id}")
def get_note(note_id: str, db: Session = Depends(session), user: User = Depends(require_user)):
    return note_json(owned_note(db, user.id, note_id))


@router.put("/{note_id}")
def update_note(
    note_id: str,
    body: NoteUpdate,
    db: Session = Depends(session),
    user: User = Depends(require_user),
):
    note = owned_note(db, user.id, note_id, lock=True)
    check_version(note, body.version)
    note.title, note.body = body.title, body.body
    note.search_text = normalize(body.title + "\n" + body.body)
    note.version += 1
    db.commit()
    return note_json(note)


@router.delete("/{note_id}", status_code=204)
def delete_note(
    note_id: str,
    version: int = Query(ge=1),
    db: Session = Depends(session),
    user: User = Depends(require_user),
):
    note = owned_note(db, user.id, note_id, lock=True)
    check_version(note, version)
    db.delete(note)
    db.commit()
