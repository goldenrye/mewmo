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
from app.models import AgentCreateRequest, AgentNoteRequest, AgentToken, Item, Note, Reminder, User


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


ALL_TOOLS = {
    "draft_reminder",
    "preview_reminder",
    "create_reminder",
    "list_reminders",
    "get_reminder",
    "list_notes",
    "search_notes",
    "get_note",
    "preview_note",
    "create_note",
}


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
    assert {t["name"] for t in tools} == ALL_TOOLS
    for entry in tools:
        assert not {"token", "password", "ctx", "user_id"} & entry["inputSchema"]["properties"].keys()
    assert next(t for t in tools if t["name"] == "create_reminder")["annotations"]["idempotentHint"]
    writers = {t["name"] for t in tools if not t["annotations"]["readOnlyHint"]}
    assert writers == {"create_reminder", "create_note"}
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
            "agent_note_requests",
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


@pytest.mark.parametrize("header", ["Authorization", "X-API-Key"])
def test_official_sdk_streamable_http_client(remote, header):
    async def scenario():
        async with app.router.lifespan_context(app) as state:

            async def scoped_app(scope, receive, send):
                scope["state"] = state.copy()
                await app(scope, receive, send)

            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=scoped_app),
                headers={header: ("Bearer " if header == "Authorization" else "") + remote["token"]},
            ) as http:
                async with streamable_http_client("http://localhost/api/mcp/", http_client=http) as (
                    read,
                    write,
                    _,
                ):
                    async with ClientSession(read, write) as sdk:
                        assert (await sdk.initialize()).serverInfo.name == "Mewmo"
                        assert {t.name for t in (await sdk.list_tools()).tools} == ALL_TOOLS
                        reviewed = await sdk.call_tool("preview_reminder", {"reminder": details()})
                        assert not reviewed.isError
                        args = create_args(reviewed.structuredContent)
                        saved = await sdk.call_tool("create_reminder", args)
                        again = await sdk.call_tool("create_reminder", args)
                        assert not saved.isError and not again.isError
                        assert again.structuredContent["replayed"]
                        assert saved.structuredContent["item_id"] == again.structuredContent["item_id"]
                        item_id = saved.structuredContent["item_id"]
                        fetched = await sdk.call_tool("get_reminder", {"item_id": item_id})
                        assert not fetched.isError and fetched.structuredContent["item"]["id"] == item_id
                        listed = await sdk.call_tool("list_reminders", {"query": "Doctor"})
                        assert not listed.isError
                        assert [item["id"] for item in listed.structuredContent["items"]] == [item_id]

                        note_preview = await sdk.call_tool(
                            "preview_note", {"title": "Floor", "body": "Living room measurements"}
                        )
                        assert not note_preview.isError
                        note_request = note_args(note_preview.structuredContent)
                        note_saved = await sdk.call_tool("create_note", note_request)
                        note_again = await sdk.call_tool("create_note", note_request)
                        assert not note_saved.isError and not note_again.isError
                        note_id = note_saved.structuredContent["note_id"]
                        assert note_again.structuredContent["replayed"]
                        assert note_again.structuredContent["note_id"] == note_id
                        for name, arguments in [("list_notes", {}), ("search_notes", {"query": "living"})]:
                            notes = await sdk.call_tool(name, arguments)
                            assert not notes.isError
                            assert [note["id"] for note in notes.structuredContent["items"]] == [note_id]
                        fetched_note = await sdk.call_tool("get_note", {"note_id": note_id})
                        assert not fetched_note.isError
                        assert fetched_note.structuredContent["note"]["body"] == "Living room measurements"

    asyncio.run(scenario())


def note_args(review, **changes):
    return {
        "title": review["note"]["title"],
        "body": review["note"]["body"],
        "preview_hash": review["preview_hash"],
        "request_id": str(uuid4()),
        "confirmed": True,
    } | changes


def preview_note(client, remote, title="Floor", body="Living room: 12500 mm by 6400 mm"):
    result = tool(client, remote, "preview_note", {"title": title, "body": body})
    assert not result.get("isError"), result
    return result["structuredContent"]


def test_list_and_get_reminders_are_read_only_and_filtered(client, remote, db):
    tool(client, remote, "create_reminder", create_args(preview(client, remote)))
    tool(
        client,
        remote,
        "create_reminder",
        create_args(preview(client, remote, title="Dentist 100%_x", due_date="2099-12-01")),
    )
    done = tool(client, remote, "create_reminder", create_args(preview(client, remote, title="Old bill")))
    assert (
        client.post(
            f"/api/items/{done['structuredContent']['item_id']}/state", json={"status": "completed"}
        ).status_code
        == 200
    )
    counts = (
        db.scalar(select(func.count()).select_from(Item)),
        db.scalar(select(func.count()).select_from(Reminder)),
    )
    listed = tool(client, remote, "list_reminders", {})["structuredContent"]
    assert listed["total"] == 2 and [i["title"] for i in listed["items"]] == ["Doctor", "Dentist 100%_x"]
    assert "not instructions" in listed["notice"]
    history = tool(client, remote, "list_reminders", {"status": "history"})["structuredContent"]
    assert [i["title"] for i in history["items"]] == ["Old bill"]
    assert tool(client, remote, "list_reminders", {"status": "all"})["structuredContent"]["total"] == 3
    # LIKE wildcards are literal.
    found = tool(client, remote, "list_reminders", {"query": "100%_"})["structuredContent"]
    assert [i["title"] for i in found["items"]] == ["Dentist 100%_x"]
    assert tool(client, remote, "list_reminders", {"query": "dent"})["structuredContent"]["total"] == 1
    paged = tool(client, remote, "list_reminders", {"limit": 1, "offset": 1})["structuredContent"]
    assert paged["total"] == 2 and len(paged["items"]) == 1
    one = tool(client, remote, "get_reminder", {"item_id": listed["items"][0]["id"]})["structuredContent"]
    assert one["item"]["due_time"] == "15:30" and one["item"]["timezone"] == "America/Los_Angeles"
    assert tool(client, remote, "get_reminder", {"item_id": str(uuid4())})["isError"]
    assert counts == (
        db.scalar(select(func.count()).select_from(Item)),
        db.scalar(select(func.count()).select_from(Reminder)),
    )


def test_note_preview_create_replay_list_search_and_get(client, remote, db):
    client.post("/api/notes", json={"confirmed": True, "title": "Wifi", "body": "Router in the hallway"})
    review = preview_note(client, remote)
    assert review["saved"] is False and review["duplicate_count"] == 0
    assert db.scalar(select(func.count()).select_from(Note)) == 1
    args = note_args(review)
    assert tool(client, remote, "create_note", args | {"confirmed": False})["isError"]
    assert tool(client, remote, "create_note", args | {"body": "changed"})["isError"]
    saved = tool(client, remote, "create_note", args)["structuredContent"]
    assert saved["saved"] and not saved["replayed"]
    again = tool(client, remote, "create_note", args)["structuredContent"]
    assert again["replayed"] and again["note_id"] == saved["note_id"]
    assert db.scalar(select(func.count()).select_from(Note)) == 2
    assert db.scalar(select(func.count()).select_from(AgentNoteRequest)) == 1
    # Visible in the app like any other note.
    assert client.get("/api/notes/" + saved["note_id"]).json()["body"] == "Living room: 12500 mm by 6400 mm"
    listed = tool(client, remote, "list_notes", {})["structuredContent"]
    assert listed["total"] == 2 and listed["items"][0]["id"] == saved["note_id"]
    found = tool(client, remote, "search_notes", {"query": "living room"})["structuredContent"]
    assert [n["id"] for n in found["items"]] == [saved["note_id"]] and found["mode"] == "local"
    got = tool(client, remote, "get_note", {"note_id": saved["note_id"]})["structuredContent"]
    assert got["note"]["title"] == "Floor"
    assert tool(client, remote, "get_note", {"note_id": str(uuid4())})["isError"]


def test_note_duplicates_reuse_and_deleted_replay(client, remote, db):
    first = note_args(preview_note(client, remote))
    saved = tool(client, remote, "create_note", first)["structuredContent"]
    review = preview_note(client, remote)
    assert review["duplicate_count"] == 1 and review["warnings"]
    dup = note_args(review)
    assert tool(client, remote, "create_note", dup)["isError"]
    assert not tool(client, remote, "create_note", dup | {"allow_duplicate": True}).get("isError")
    other = note_args(preview_note(client, remote, body="Different"), request_id=first["request_id"])
    assert tool(client, remote, "create_note", other)["isError"]
    assert client.delete(f"/api/notes/{saved['note_id']}?version=1").status_code == 204
    replay = tool(client, remote, "create_note", first)["structuredContent"]
    assert replay["replayed"] and replay["deleted"]
    assert db.scalar(select(func.count()).select_from(Note)) == 1
    assert tool(client, remote, "preview_note", {"title": "  ", "body": "x"})["isError"]


def test_reads_are_user_isolated(client, remote, db):
    tool(client, remote, "create_reminder", create_args(preview(client, remote)))
    tool(client, remote, "create_note", note_args(preview_note(client, remote)))
    item_id = tool(client, remote, "list_reminders", {})["structuredContent"]["items"][0]["id"]
    note_id = tool(client, remote, "list_notes", {})["structuredContent"]["items"][0]["id"]
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
    other = client.post("/api/agent-tokens", json={"name": "Other agent"}).json()
    assert tool(client, other, "list_reminders", {"status": "all"})["structuredContent"]["total"] == 0
    assert tool(client, other, "list_notes", {})["structuredContent"]["total"] == 0
    assert tool(client, other, "search_notes", {"query": "living"})["structuredContent"]["total"] == 0
    assert tool(client, other, "get_reminder", {"item_id": item_id})["isError"]
    assert tool(client, other, "get_note", {"note_id": note_id})["isError"]
    assert preview_note(client, other)["duplicate_count"] == 0


def key_rpc(client, headers, path="/api/mcp/"):
    return client.post(
        path,
        headers=[("Host", "localhost"), ("Accept", "application/json, text/event-stream"), *headers],
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
    )


def test_api_key_expiry_revocation_and_no_general_api_access(client, remote, db):
    headers = [("X-API-Key", remote["token"])]
    assert key_rpc(client, headers).status_code == 200
    client.delete("/api/agent-tokens/" + remote["id"])
    assert key_rpc(client, headers).status_code == 401
    db.expire_all()
    token = db.get(AgentToken, remote["id"])
    token.revoked_at = None
    token.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    db.commit()
    assert key_rpc(client, headers).status_code == 401
    token.expires_at = datetime.now(UTC) + timedelta(days=1)
    db.commit()
    client.cookies.clear()
    assert key_rpc(client, headers).status_code == 200
    for path in ["/api/items", "/api/notes", "/api/model-settings", "/api/agent-tokens"]:
        assert client.get(path, headers=headers).status_code == 401


def test_matching_credentials_accepted_and_cross_account_conflict_rejected(client, remote, db):
    assert (
        key_rpc(
            client, [("Authorization", "Bearer " + remote["token"]), ("x-api-key", remote["token"])]
        ).status_code
        == 200
    )
    db.add(
        User(
            id="second",
            username="second",
            display_name="Second",
            password_hash=password_hash("test-password-2"),
        )
    )
    secret = "mewmo_mcp_" + "b" * 64
    db.add(
        AgentToken(
            user_id="second",
            name="Other",
            token_hash=token_hash(secret),
            expires_at=datetime.now(UTC) + timedelta(days=1),
        )
    )
    db.commit()
    assert key_rpc(client, [("X-API-Key", secret)]).status_code == 200
    result = key_rpc(client, [("Authorization", "Bearer " + remote["token"]), ("X-API-Key", secret)])
    assert result.status_code == 401
    assert secret not in result.text and remote["token"] not in result.text


@pytest.mark.parametrize(
    "case",
    [
        "bad-bearer",
        "bad-key",
        "empty-bearer",
        "empty-key",
        "duplicate-key",
        "duplicate-bearer",
        "prefixed-key",
        "query-key",
    ],
)
def test_api_key_never_falls_back_from_ambiguous_credentials(client, remote, case):
    key = remote["token"]
    headers = {
        "bad-bearer": [("Authorization", "Basic invalid"), ("X-API-Key", key)],
        "bad-key": [("Authorization", "Bearer " + key), ("X-API-Key", "invalid")],
        "empty-bearer": [("Authorization", ""), ("X-API-Key", key)],
        "empty-key": [("Authorization", "Bearer " + key), ("X-API-Key", "")],
        "duplicate-key": [("X-API-Key", key), ("X-API-Key", key)],
        "duplicate-bearer": [("Authorization", "Bearer " + key)] * 2,
        "prefixed-key": [("X-API-Key", "Bearer " + key)],
        "query-key": [],
    }[case]
    path = "/api/mcp/?api_key=" + key if case == "query-key" else "/api/mcp/"
    assert key_rpc(client, headers, path).status_code == 401


def test_browser_api_key_preflight_and_untrusted_origin(client, remote):
    response = client.options(
        "/api/mcp/",
        headers={
            "Host": "localhost",
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "x-api-key,content-type,mcp-protocol-version",
        },
    )
    assert response.status_code == 200
    assert "x-api-key" in response.headers["access-control-allow-headers"].lower()
    assert (
        key_rpc(client, [("X-API-Key", remote["token"]), ("Origin", "https://evil.example")]).status_code
        == 403
    )
