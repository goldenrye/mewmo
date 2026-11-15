import asyncio
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import httpx
import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from sqlalchemy import create_engine, func, inspect, select
from sqlalchemy.exc import SQLAlchemyError

from app.auth import password_hash, token_hash
from app.config import settings
from app.main import app
from app.models import AgentCreateRequest, AgentToken, Item, Reminder, User


@pytest.fixture
def remote(client, db, monkeypatch):
    monkeypatch.setattr("app.remote_mcp.engine", lambda: db.get_bind())
    result = client.post("/api/agent-tokens", json={"name": "Test agent"})
    assert result.status_code == 201
    return result.json()


def rpc(client, token, method, params=None, **headers):
    return client.post(
        "/api/mcp/",
        headers={
            "Host": "localhost",
            "Authorization": "Bearer " + token,
            "Accept": "application/json, text/event-stream",
            **headers,
        },
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}},
    )


def tool(client, remote, name, arguments):
    response = rpc(client, remote["token"], "tools/call", {"name": name, "arguments": arguments})
    assert response.status_code == 200, response.text
    return response.json()["result"]


def details(**changes):
    return {
        "title": "Doctor",
        "kind": "appointment",
        "due_date": "2099-11-20",
        "due_time": "15:30",
        "timezone": "America/Los_Angeles",
    } | changes


def preview(client, remote, **changes):
    result = tool(client, remote, "preview_reminder", {"reminder": details(**changes)})
    assert not result.get("isError"), result
    return result["structuredContent"]


def create_args(preview, **changes):
    return {
        "reminder": preview["reminder"],
        "preview_hash": preview["preview_hash"],
        "request_id": str(uuid4()),
        "confirmed": True,
    } | changes


def test_initialize_discover_preview_create_and_replay(client, remote, db):
    init = rpc(
        client,
        remote["token"],
        "initialize",
        {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "test-agent", "version": "1.0"},
        },
    )
    assert init.status_code == 200
    assert init.json()["result"]["serverInfo"]["name"] == "Mewmo"
    tools = rpc(client, remote["token"], "tools/list").json()["result"]["tools"]
    assert {t["name"] for t in tools} == {"draft_reminder", "preview_reminder", "create_reminder"}
    for entry in tools:
        assert not {"token", "password", "ctx", "user_id"} & entry["inputSchema"]["properties"].keys()
    assert next(t for t in tools if t["name"] == "create_reminder")["annotations"]["idempotentHint"]
    review = preview(client, remote)
    assert review["saved"] is False
    assert review["due_display"] == "Friday, 2099-11-20 at 15:30 America/Los_Angeles"
    assert db.scalar(select(func.count()).select_from(Item)) == 0
    args = create_args(review)
    rejected = tool(client, remote, "create_reminder", args | {"confirmed": False})
    assert rejected["isError"]
    result = tool(client, remote, "create_reminder", args)["structuredContent"]
    assert result["saved"] and not result["replayed"]
    replay = tool(client, remote, "create_reminder", args)["structuredContent"]
    assert replay["replayed"] and replay["item_id"] == result["item_id"]
    assert db.scalar(select(func.count()).select_from(Item)) == 1
    assert db.scalar(select(func.count()).select_from(Reminder)) == 2
    assert db.scalar(select(func.count()).select_from(AgentCreateRequest)) == 1


def test_replay_survives_new_server_lifespan_and_deleted_item(client, remote):
    args = create_args(preview(client, remote))
    saved = tool(client, remote, "create_reminder", args)["structuredContent"]
    assert client.delete("/api/items/" + saved["item_id"]).status_code == 204
    with TestClient(app) as restarted:
        result = tool(restarted, remote, "create_reminder", args)["structuredContent"]
    assert result == {"saved": True, "replayed": True, "item_id": saved["item_id"], "status": "deleted"}


def test_reusing_request_id_for_changed_details_is_rejected(client, remote, db):
    args = create_args(preview(client, remote))
    tool(client, remote, "create_reminder", args)
    updated = create_args(preview(client, remote, title="Different"), request_id=args["request_id"])
    assert tool(client, remote, "create_reminder", updated)["isError"]
    assert db.scalar(select(func.count()).select_from(Item)) == 1


@pytest.mark.parametrize(
    "change",
    [
        {"timezone": "Invalid/Zone"},
        {"urgent": 1},
        {"title": "  "},
        {"kind": "bill"},
        {"due_time": "24:00"},
        {"user_id": "other"},
        {"due_date": "2027-03-14", "due_time": "02:30", "timezone": "America/New_York"},
        {"due_date": "2026-11-01", "due_time": "01:30", "timezone": "America/New_York"},
    ],
)
def test_invalid_fields_never_save(client, remote, db, change):
    assert tool(client, remote, "preview_reminder", {"reminder": details(**change)})["isError"]
    assert db.scalar(select(func.count()).select_from(Item)) == 0


def test_edited_preview_hash_and_unknown_tools_cannot_save(client, remote, db):
    args = create_args(preview(client, remote))
    args["reminder"]["title"] = "Unapproved"
    assert tool(client, remote, "create_reminder", args)["isError"]
    assert tool(client, remote, "delete_reminder", {"id": str(uuid4())})["isError"]
    assert db.scalar(select(func.count()).select_from(Item)) == 0


def test_urgent_tier_and_redaction_match_regular_api(client, remote, db):
    review = preview(client, remote, urgent=True, title="Call account 123456789012")
    assert "123456789012" not in json.dumps(review)
    result = tool(client, remote, "create_reminder", create_args(review))["structuredContent"]
    assert [r["minutes"] for r in result["item"]["rules"]] == [10080, 1440, 60, 0]
    assert result["item"]["early_alarm_id"] != result["item_id"]
    assert "not a direct iPhone alarm" in result["alarm_notice"]
    assert db.scalar(select(func.count()).select_from(Reminder)) == 4


def test_duplicate_must_be_acknowledged_even_if_created_after_preview(client, remote, db):
    review = preview(client, remote)
    tool(client, remote, "create_reminder", create_args(review))
    second = create_args(review)
    assert tool(client, remote, "create_reminder", second)["isError"]
    assert preview(client, remote)["duplicate_count"] == 1
    assert not tool(client, remote, "create_reminder", second | {"allow_duplicate": True}).get("isError")
    assert db.scalar(select(func.count()).select_from(Item)) == 2


def test_token_is_hash_only_and_scoped_not_a_login_session(client, remote, db):
    token = db.scalar(select(AgentToken))
    assert token.token_hash == token_hash(remote["token"])
    listed = client.get("/api/agent-tokens").json()
    assert remote["token"] not in json.dumps(listed) and "token_hash" not in json.dumps(listed)
    assert listed["endpoint"].endswith("/api/mcp/")
    for path in ["/api/items", "/api/notes", "/api/model-settings", "/api/agent-tokens"]:
        assert client.get(path, headers={"Authorization": "Bearer " + remote["token"]}).status_code == 401
    # Browser cookies and ordinary session bearer tokens do not grant agent access.
    assert rpc(client, client.cookies["mewmo_session"], "tools/list").status_code == 401
    assert client.post("/api/mcp/", headers={"Host": "localhost"}).status_code == 401


def test_revocation_and_expiry_block_discovery_and_cached_replay(client, remote, db):
    args = create_args(preview(client, remote))
    tool(client, remote, "create_reminder", args)
    assert client.delete("/api/agent-tokens/" + remote["id"]).status_code == 204
    response = rpc(client, remote["token"], "tools/call", {"name": "create_reminder", "arguments": args})
    assert response.status_code == 401 and "Bearer" in response.headers["www-authenticate"]
    db.expire_all()
    token = db.get(AgentToken, remote["id"])
    token.revoked_at = None
    token.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    db.commit()
    assert rpc(client, remote["token"], "tools/list").status_code == 401


def test_untrusted_origin_and_host_rejected(client, remote):
    assert rpc(client, remote["token"], "tools/list", Origin="https://evil.example").status_code == 403
    assert rpc(client, remote["token"], "tools/list", Host="evil.example").status_code == 403
    response = client.post(
        "/api/mcp/",
        headers={
            "Host": "localhost",
            "Authorization": "Bearer " + remote["token"],
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
        },
        content='{"padding":"' + "x" * 70000 + '"}',
    )
    assert response.status_code == 413


def test_tokens_and_request_ids_are_user_isolated(client, remote, db):
    args = create_args(preview(client, remote))
    own = tool(client, remote, "create_reminder", args)["structuredContent"]
    db.add(
        User(
            id="other",
            username="other",
            display_name="Other",
            password_hash=password_hash("other-test-password"),
        )
    )
    db.commit()
    client.post("/api/auth/login", json={"username": "other", "password": "other-test-password"})
    assert client.get("/api/agent-tokens").json()["tokens"] == []
    assert client.delete("/api/agent-tokens/" + remote["id"]).status_code == 404
    other = client.post("/api/agent-tokens", json={"name": "Other agent"}).json()
    assert preview(client, other)["duplicate_count"] == 0
    saved = tool(client, other, "create_reminder", args)["structuredContent"]
    assert saved["item_id"] != own["item_id"] and not saved["replayed"]
    db.expire_all()
    assert db.get(Item, saved["item_id"]).user_id == "other"
    assert db.get(Item, own["item_id"]).user_id != "other"


def test_chinese_draft_is_unsaved_and_never_enables_urgency(client, remote, db):
    from app.parsing import parse_text
    from app.schemas import ParseRequest

    expected = parse_text(
        ParseRequest(
            text="后天9点有医生预约",
            timezone="Asia/Shanghai",
            local_date="2026-11-06",
            client_now="2026-11-06T12:00:00+08:00",
        )
    )
    with patch("app.main.assist_draft", return_value=expected):
        result = tool(
            client, remote, "draft_reminder", {"text": "后天9点有医生预约", "timezone": "Asia/Shanghai"}
        )["structuredContent"]
    assert result["draft"]["due_date"] == "2026-11-08"
    assert result["draft"]["due_time"] == "09:00" and result["draft"]["urgent"] is False
    assert result["saved"] is False
    assert db.scalar(select(func.count()).select_from(Item)) == 0


def test_token_lifetime_limit_and_active_token_limit(client, remote):
    for days in [0, 91, "30"]:
        assert (
            client.post("/api/agent-tokens", json={"name": "Invalid", "expires_days": days}).status_code
            == 422
        )
    for i in range(9):
        assert client.post("/api/agent-tokens", json={"name": f"Agent {i}"}).status_code == 201
    assert client.post("/api/agent-tokens", json={"name": "Too many"}).status_code == 409
    client.delete("/api/agent-tokens/" + remote["id"])
    assert client.post("/api/agent-tokens", json={"name": "Replacement"}).status_code == 201


def test_migration_adds_agent_tables_without_changing_existing_items(tmp_path, monkeypatch):
    monkeypatch.setattr(settings(), "admin_password_hash", password_hash("test-password-long"))
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "migrations"))
    engine = create_engine(f"sqlite:///{tmp_path}/mcp.db")
    with engine.begin() as connection:
        config.attributes["connection"] = connection
        command.upgrade(config, "0007")
        before = set(inspect(connection).get_table_names())
        command.upgrade(config, "head")
        assert set(inspect(connection).get_table_names()) - before == {
            "agent_tokens",
            "agent_create_requests",
        }
        command.downgrade(config, "0007")
        assert set(inspect(connection).get_table_names()) == before
    engine.dispose()


def test_failed_schedule_rolls_back_item_and_request_key_together(client, remote, db):
    args = create_args(preview(client, remote))
    with patch("app.remote_mcp.reconcile", side_effect=SQLAlchemyError("synthetic failure")):
        failed = tool(client, remote, "create_reminder", args)
    assert failed["isError"]
    assert db.scalar(select(func.count()).select_from(Item)) == 0
    assert db.scalar(select(func.count()).select_from(AgentCreateRequest)) == 0
    assert not tool(client, remote, "create_reminder", args).get("isError")
    assert db.scalar(select(func.count()).select_from(Item)) == 1


def test_past_urgent_create_does_not_send_late_alarms(client, remote, db):
    review = preview(client, remote, due_date="2000-01-01", urgent=True)
    assert any("already passed" in warning for warning in review["warnings"])
    assert not tool(client, remote, "create_reminder", create_args(review)).get("isError")
    assert db.scalar(select(func.count()).select_from(Reminder)) == 0


def test_official_sdk_streamable_http_client(remote):
    async def scenario():
        async with app.router.lifespan_context(app) as state:

            async def scoped_app(scope, receive, send):
                scope["state"] = state.copy()
                await app(scope, receive, send)

            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=scoped_app),
                headers={"Authorization": "Bearer " + remote["token"]},
            ) as http:
                async with streamable_http_client("http://localhost/api/mcp/", http_client=http) as (
                    read,
                    write,
                    _,
                ):
                    async with ClientSession(read, write) as sdk:
                        assert (await sdk.initialize()).serverInfo.name == "Mewmo"
                        assert len((await sdk.list_tools()).tools) == 3
                        reviewed = await sdk.call_tool("preview_reminder", {"reminder": details()})
                        assert not reviewed.isError
                        args = create_args(reviewed.structuredContent)
                        saved = await sdk.call_tool("create_reminder", args)
                        again = await sdk.call_tool("create_reminder", args)
                        assert not saved.isError and not again.isError
                        assert again.structuredContent["replayed"]
                        assert saved.structuredContent["item_id"] == again.structuredContent["item_id"]

    asyncio.run(scenario())
