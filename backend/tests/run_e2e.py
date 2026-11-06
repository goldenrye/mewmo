"""Disposable localhost server for browser tests. Never points at production data."""

import os
import tempfile

import uvicorn

from app.auth import password_hash

with tempfile.TemporaryDirectory(prefix="mewmo-browser-") as directory:
    os.environ["DATABASE_URL"] = f"sqlite:///{directory}/test.db"
    os.environ["OWNER_PASSWORD_HASH"] = password_hash("mewmo-local-test")
    os.environ["COOKIE_SECURE"] = "false"
    os.environ["CORS_ORIGINS"] = "http://localhost:5173,http://127.0.0.1:5173,capacitor://localhost"

    from app.config import settings

    settings.cache_clear()
    from app.database import engine
    from app.models import Base

    Base.metadata.create_all(engine())
    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, access_log=False)
