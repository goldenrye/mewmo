import os

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

os.environ["COOKIE_SECURE"] = "false"

from app.accounts import attempts
from app.auth import password_hash
from app.config import settings
from app.database import session
from app.main import app
from app.models import Base, User


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        db.add(
            User(
                id="00000000-0000-4000-8000-000000000001",
                username="admin",
                display_name="Administrator",
                password_hash=password_hash("test-only-password"),
                is_admin=True,
            )
        )
        db.commit()
        yield db
    engine.dispose()


@pytest.fixture
def client(db):
    settings().owner_password_hash = password_hash("test-only-password")
    settings().cookie_secure = False
    settings().public_web_url = "http://localhost:5173"
    attempts.clear()
    app.dependency_overrides[session] = lambda: db
    with TestClient(app) as client:
        client.headers["X-Client-Key"] = "1" * 64
        response = client.post(
            "/api/auth/login", json={"username": "admin", "password": "test-only-password"}
        )
        assert response.status_code == 200
        yield client
    app.dependency_overrides.clear()


@pytest.fixture
def bill_input():
    return {
        "confirmed": True,
        "local_date": "2026-11-06",
        "timezone": "America/Los_Angeles",
        "kind": "bill",
        "title": "Electricity",
        "payee": "Utility Co",
        "amount": "120.50",
        "currency": "USD",
        "due_date": "2099-11-20",
        "due_time": "09:00",
        "status": "open",
    }
