import os

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

os.environ["COOKIE_SECURE"] = "false"

from app.auth import password_hash
from app.config import settings
from app.database import session
from app.main import app, attempts
from app.models import Base


@pytest.fixture
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        yield db
    engine.dispose()


@pytest.fixture
def client(db):
    settings().owner_password_hash = password_hash("test-only-password")
    settings().cookie_secure = False
    attempts.clear()
    app.dependency_overrides[session] = lambda: db
    with TestClient(app) as client:
        response = client.post("/api/auth/login", json={"password": "test-only-password"})
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
