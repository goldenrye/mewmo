from unittest.mock import patch

import pytest
from sqlalchemy import select

from app.models import AuthSession, Item, Reminder
from app.push import valid_web_endpoint


def test_auth_required(client):
    client.cookies.clear()
    assert client.get("/api/items").status_code == 401
    assert client.post("/api/auth/login", json={"username": "admin", "password": "wrong"}).status_code == 401


def test_old_iphone_login_explains_update_without_defaulting_to_admin(client, db):
    client.cookies.clear()
    sessions_before = len(db.scalars(select(AuthSession)).all())
    response = client.post(
        "/api/auth/login",
        headers={"Origin": "capacitor://localhost"},
        json={"password": "test-only-password"},
    )
    assert response.status_code == 422
    assert "Username is required" in response.json()["detail"]
    assert "update the Mewmo iPhone app" in response.json()["detail"]
    assert "test-only-password" not in response.text
    assert "set-cookie" not in response.headers
    assert len(db.scalars(select(AuthSession)).all()) == sessions_before


def test_validation_errors_name_fields_without_echoing_credentials(client):
    response = client.post(
        "/api/auth/register",
        json={"username": "alice", "password": "secret"},
    )
    assert response.status_code == 422
    errors = response.json()["detail"]
    assert any(e["loc"] == ["body", "invite_token"] for e in errors)
    assert "secret" not in response.text
    assert all(set(e) == {"type", "loc", "msg"} for e in errors)


def test_updated_iphone_login_returns_working_session(client):
    client.cookies.clear()
    response = client.post(
        "/api/auth/login",
        headers={"Origin": "capacitor://localhost"},
        json={"username": "admin", "password": "test-only-password"},
    )
    assert response.status_code == 200
    assert response.json()["user"]["username"] == "admin"
    token = response.json()["token"]
    assert token
    client.cookies.clear()
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"}).status_code == 200


def test_csrf_origin_rejected(client):
    assert client.post("/api/auth/logout", headers={"origin": "https://evil.example"}).status_code == 403


def test_native_context_headers_are_allowed(client):
    response = client.options(
        "/api/items",
        headers={
            "Origin": "capacitor://localhost",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization,x-client-date,x-client-timezone,x-client-key,x-account-id",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "capacitor://localhost"


def test_confirmation_is_required(client, bill_input):
    bill_input.pop("confirmed")
    assert client.post("/api/items", json=bill_input).status_code == 422
    bill_input["confirmed"] = False
    assert client.post("/api/items", json=bill_input).status_code == 422
    assert client.get("/api/items").json() == []


def test_create_edit_delete_history_and_undo(client, bill_input, db):
    created = client.post("/api/items", json=bill_input)
    assert created.status_code == 201
    item_id = created.json()["id"]
    assert len(client.get(f"/api/items/{item_id}/reminders").json()) == 4
    assert client.post(f"/api/items/{item_id}/state", json={"status": "paid"}).status_code == 200
    assert client.get("/api/items").json() == []
    assert client.get("/api/items?history=true").json()[0]["id"] == item_id
    assert all(r["status"] == "cancelled" for r in client.get(f"/api/items/{item_id}/reminders").json())
    client.post(f"/api/items/{item_id}/state", json={"status": "open"})
    assert all(r["status"] == "pending" for r in client.get(f"/api/items/{item_id}/reminders").json())
    response = client.put(
        f"/api/items/{item_id}", json=bill_input | {"title": "Updated electricity", "due_date": "2099-12-20"}
    )
    assert response.status_code == 200
    reminders = client.get(f"/api/items/{item_id}/reminders").json()
    assert sum(r["status"] == "pending" for r in reminders) == 4
    assert sum(r["status"] == "cancelled" for r in reminders) == 4
    assert client.delete(f"/api/items/{item_id}").status_code == 204
    assert client.get("/api/items").json() == []
    assert client.get(f"/api/items/{item_id}/reminders").status_code == 404
    assert db.get(Item, item_id).payee is None
    assert all(
        r.status == "cancelled" for r in db.scalars(select(Reminder).where(Reminder.item_id == item_id))
    )


def test_home_sorts_overdue_first(client, bill_input):
    for day in ["2099-12-20", "2020-01-01", "2099-11-20"]:
        client.post("/api/items", json=bill_input | {"due_date": day})
    assert [i["due_date"] for i in client.get("/api/items").json()] == [
        "2020-01-01",
        "2099-11-20",
        "2099-12-20",
    ]


def test_duplicate_file_warning(client, bill_input):
    first = client.post("/api/items", json=bill_input).json()
    with patch(
        "app.main.extract_file",
        return_value="INVOICE\nPayee: Utility Co\nAmount due: USD 120.50\nDue date: 2099-11-20",
    ):
        result = client.post("/api/drafts/file?local_date=2026-11-06&timezone=UTC", content=b"file")
    assert result.status_code == 200
    assert first["id"] in result.json()["duplicates"]


def test_paid_bill_creates_no_reminders(client, bill_input):
    result = client.post("/api/items", json=bill_input | {"status": "paid"})
    assert result.status_code == 201
    assert client.get(f"/api/items/{result.json()['id']}/reminders").json() == []


@pytest.mark.parametrize(
    "patch_value",
    [
        {"timezone": "Mars/Olympus"},
        {"amount": "-1"},
        {"account_last4": "123456"},
        {"status": "completed"},
        {"due_time": "24:00"},
        {"payee": ""},
        {"due_date": "2027-03-14", "due_time": "02:30"},
        {"due_date": "2026-11-01", "due_time": "01:30"},
    ],
)
def test_invalid_inputs_rejected(client, bill_input, patch_value):
    assert client.post("/api/items", json=bill_input | patch_value).status_code == 422


def test_custom_rules_and_zero_rules(client, bill_input):
    custom = [{"mode": "before", "minutes": 10, "days": 0, "at": "09:00"}]
    value = client.post("/api/items", json=bill_input | {"rules": custom}).json()
    assert len(client.get(f"/api/items/{value['id']}/reminders").json()) == 1
    value = client.post("/api/items", json=bill_input | {"rules": []}).json()
    assert client.get(f"/api/items/{value['id']}/reminders").json() == []


def test_device_registration_idempotent_and_disable(client):
    body = {"platform": "ios", "token": "a" * 64}
    first = client.post("/api/devices", json=body)
    second = client.post("/api/devices", json=body)
    assert first.json() == second.json()
    assert len(client.get("/api/devices").json()) == 1
    assert client.delete(f"/api/devices/{first.json()['id']}").status_code == 204
    assert not client.get("/api/devices").json()[0]["active"]


def test_logout_revokes_session(client):
    cookies = dict(client.cookies)
    assert client.post("/api/auth/logout").status_code == 200
    client.cookies.update(cookies)
    assert client.get("/api/items").status_code == 401


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/push",
        "https://evil.example",
        "https://fcm.googleapis.com.evil.example",
        "https://fcm.googleapis.com:8443/x",
        "https://user:pass@fcm.googleapis.com/x",
    ],
)
def test_web_push_ssrf_rejected(url):
    assert not valid_web_endpoint(url)
