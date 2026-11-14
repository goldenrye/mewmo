from datetime import timedelta
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import pytest
from sqlalchemy import func, select

from app.accounts import attempts
from app.auth import password_hash, token_hash
from app.config import settings
from app.models import AuthSession, Delivery, Device, Invitation, Item, Reminder, User, now
from app.reminders import dispatch_one

ADMIN_ID = "00000000-0000-4000-8000-000000000001"


def invite(client):
    response = client.post("/api/admin/invitations")
    assert response.status_code == 201, response.text
    result = response.json()
    return result, parse_qs(urlsplit(result["url"]).fragment)["invite"][0]


def signup(client, token, username="alice", **extra):
    return client.post(
        "/api/auth/register",
        json={
            "username": username,
            "display_name": username.title(),
            "password": "alice-password-long",
            "invite_token": token,
            **extra,
        },
    )


def login_admin(client):
    response = client.post("/api/auth/login", json={"username": "admin", "password": "test-only-password"})
    assert response.status_code == 200, response.text


def test_admin_invitation_is_seven_days_hashed_and_single_use(client, db):
    result, token = invite(client)
    row = db.get(Invitation, result["id"])
    assert row.expires_at - row.created_at == timedelta(days=7)
    assert row.token_hash == token_hash(token)
    assert token not in str(client.get("/api/admin/invitations").json())
    response = signup(client, token, "Alice", is_admin=True)
    assert response.status_code == 201
    assert response.json()["user"]["username"] == "alice"
    assert response.json()["user"]["is_admin"] is False
    assert response.json()["token"] is None
    assert "password" not in str(response.json())
    assert db.scalar(select(User).where(User.username == "alice")).password_hash != "alice-password-long"
    assert db.get(Invitation, result["id"]).used_by == response.json()["user"]["id"]
    assert signup(client, token, "second-user").status_code == 400
    assert db.scalar(select(func.count()).select_from(User)) == 2


@pytest.mark.parametrize("offset", [timedelta(0), timedelta(seconds=1)])
def test_invite_expires_at_exact_seven_day_boundary(client, db, offset):
    result, token = invite(client)
    expires = db.get(Invitation, result["id"]).expires_at
    with patch("app.accounts.now", return_value=expires + offset):
        assert signup(client, token).status_code == 400
    assert db.scalar(select(func.count()).select_from(User)) == 1


def test_expired_revoked_and_invalid_invites_cannot_create_users(client, db):
    result, token = invite(client)
    assert client.delete(f"/api/admin/invitations/{result['id']}").status_code == 204
    assert signup(client, token).status_code == 400
    assert signup(client, "x" * 43).status_code == 400
    assert client.get("/api/admin/invitations").json()[0]["status"] == "revoked"
    assert db.scalar(select(func.count()).select_from(User)) == 1


def test_username_conflict_and_invalid_password_do_not_consume_invite(client, db):
    result, token = invite(client)
    assert signup(client, token, "ADMIN").status_code == 409
    assert signup(client, token, password="short").status_code == 422
    assert db.get(Invitation, result["id"]).used_at is None
    assert signup(client, token).status_code == 201


def test_members_cannot_create_list_or_revoke_invitations(client):
    result, token = invite(client)
    assert signup(client, token).status_code == 201
    assert client.get("/api/admin/invitations").status_code == 403
    assert client.post("/api/admin/invitations").status_code == 403
    assert client.delete(f"/api/admin/invitations/{result['id']}").status_code == 403
    client.cookies.clear()
    assert client.post("/api/admin/invitations").status_code == 401


def test_private_items_history_mutations_reminders_and_duplicates(client, bill_input, db):
    item = client.post("/api/items", json=bill_input).json()
    history = client.post("/api/items", json=bill_input | {"status": "paid"}).json()
    _, token = invite(client)
    member = signup(client, token).json()["user"]
    assert client.get("/api/items").json() == []
    assert client.get("/api/items?history=true").json() == []
    for row in (item, history):
        path = f"/api/items/{row['id']}"
        assert client.get(path).status_code == 404
        assert client.get(path + "/reminders").status_code == 404
        assert client.put(path, json=bill_input).status_code == 404
        assert client.post(path + "/state", json={"status": "paid"}).status_code == 404
        assert client.delete(path).status_code == 404
    with patch(
        "app.main.extract_file",
        return_value="INVOICE\nPayee: Utility Co\nAmount due: USD 120.50\nDue date: 2099-11-20",
    ):
        draft = client.post("/api/drafts/file?local_date=2026-11-06&timezone=UTC", content=b"file").json()
    assert draft["duplicates"] == []
    own = client.post("/api/items", json=bill_input | {"user_id": ADMIN_ID}).json()
    assert db.get(Item, own["id"]).user_id == member["id"]
    assert client.get(f"/api/items/{own['id']}").json()["id"] == own["id"]
    login_admin(client)
    assert [row["id"] for row in client.get("/api/items").json()] == [item["id"]]
    assert client.get(f"/api/items/{own['id']}").status_code == 404
    assert client.get(f"/api/items/{own['id']}/reminders").status_code == 404
    assert client.delete(f"/api/items/{own['id']}").status_code == 404


def test_text_duplicates_are_private(client, bill_input):
    client.post("/api/items", json=bill_input | {"payee": "Electricity", "amount": "120"})
    _, token = invite(client)
    signup(client, token)
    response = client.post(
        "/api/drafts/text",
        json={
            "text": "Electricity USD 120 due 2099-11-20 at 09:00",
            "local_date": "2026-11-06",
            "timezone": "UTC",
        },
    )
    assert response.status_code == 200
    assert response.json()["duplicates"] == []


def test_push_only_uses_item_owners_devices(client, bill_input, db):
    own_device = client.post("/api/devices", json={"platform": "ios", "token": "a" * 64}).json()["id"]
    item = client.post("/api/items", json=bill_input | {"rules": []}).json()
    _, token = invite(client)
    # Another installation must not disable the administrator's device.
    client.headers["X-Client-Key"] = "2" * 64
    member = signup(client, token).json()["user"]
    client.post("/api/devices", json={"platform": "ios", "token": "b" * 64})
    assert client.delete(f"/api/devices/{own_device}").status_code == 404
    assert own_device not in str(client.get("/api/devices").json())
    stamp = now()
    reminder = Reminder(item_id=item["id"], rule_key="test", fire_at=stamp, next_attempt_at=stamp)
    db.add(reminder)
    db.commit()
    calls = []
    dispatch_one(db, reminder.id, lambda device, _: calls.append(device.id), stamp)
    db.commit()
    assert calls == [own_device]
    assert db.get(Device, own_device).user_id != member["id"]
    assert reminder.status == "sent"


def test_other_users_devices_cannot_make_a_reminder_sent(client, bill_input, db):
    item = client.post("/api/items", json=bill_input | {"rules": []}).json()
    _, token = invite(client)
    signup(client, token)
    client.post("/api/devices", json={"platform": "ios", "token": "b" * 64})
    stamp = now()
    reminder = Reminder(item_id=item["id"], rule_key="test", fire_at=stamp, next_attempt_at=stamp)
    db.add(reminder)
    db.commit()
    dispatch_one(db, reminder.id, lambda *_: pytest.fail("cross-account push"), stamp)
    assert reminder.status == "failed"
    assert reminder.error == "no_registered_device"


def test_account_switch_disables_installation_and_preserves_delivery_ownership(client, bill_input, db):
    device_id = client.post("/api/devices", json={"platform": "ios", "token": "a" * 64}).json()["id"]
    item = client.post("/api/items", json=bill_input | {"rules": []}).json()
    stamp = now()
    reminder = Reminder(item_id=item["id"], rule_key="test", fire_at=stamp, next_attempt_at=stamp)
    db.add(reminder)
    db.flush()
    db.add(Delivery(reminder_id=reminder.id, device_id=device_id, status="sent", accepted_at=stamp))
    db.commit()
    _, token = invite(client)
    member = signup(client, token).json()["user"]
    assert not db.get(Device, device_id).active
    new_device = client.post("/api/devices", json={"platform": "ios", "token": "A" * 64}).json()["id"]
    assert new_device != device_id
    assert db.get(Device, device_id).user_id == ADMIN_ID
    assert db.get(Device, device_id).subscription == {}
    assert db.get(Device, new_device).user_id == member["id"]
    assert db.scalar(select(Delivery)).device_id == device_id
    dispatch_one(db, reminder.id, lambda *_: pytest.fail("reassigned device got old owner's reminder"), stamp)
    assert reminder.status == "sent"
    assert client.post("/api/auth/logout").status_code == 200
    assert not db.get(Device, new_device).active


def test_logout_disables_only_this_installation(client, db):
    first = client.post("/api/devices", json={"platform": "ios", "token": "a" * 64}).json()["id"]
    client.headers["X-Client-Key"] = "2" * 64
    second = client.post("/api/devices", json={"platform": "ios", "token": "b" * 64}).json()["id"]
    assert client.post("/api/auth/logout").status_code == 200
    assert db.get(Device, first).active
    assert not db.get(Device, second).active


def test_stale_tab_account_header_cannot_mutate_new_accounts_data(client, bill_input):
    _, token = invite(client)
    signup(client, token)
    client.headers["X-Account-ID"] = ADMIN_ID
    assert client.post("/api/items", json=bill_input).status_code == 401
    del client.headers["X-Account-ID"]
    assert client.get("/api/items").json() == []


def test_password_change_revokes_other_sessions_and_not_other_users(client, db):
    old_session = client.cookies.get("mewmo_session")
    login_admin(client)
    member = User(username="bob", display_name="Bob", password_hash=password_hash("bob-password-long"))
    db.add(member)
    db.flush()
    db.add(
        AuthSession(user_id=member.id, token_hash="other-user-session", expires_at=now() + timedelta(days=1))
    )
    db.commit()
    assert (
        client.post(
            "/api/auth/password",
            json={
                "current_password": "wrong",
                "new_password": "new-admin-password",
            },
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/api/auth/password",
            json={
                "current_password": "test-only-password",
                "new_password": "new-admin-password",
            },
        ).status_code
        == 200
    )
    assert db.get(AuthSession, token_hash(old_session)) is None
    assert db.get(AuthSession, "other-user-session") is not None
    assert client.get("/api/auth/me").status_code == 200
    assert (
        client.post(
            "/api/auth/login",
            json={
                "username": "admin",
                "password": "test-only-password",
            },
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/api/auth/login",
            json={
                "username": "admin",
                "password": "new-admin-password",
            },
        ).status_code
        == 200
    )


def test_username_rate_limits_do_not_block_another_user(client, db):
    db.add(User(username="bob", display_name="Bob", password_hash=password_hash("bob-password-long")))
    db.commit()
    attempts.clear()
    for _ in range(10):
        assert (
            client.post("/api/auth/login", json={"username": "admin", "password": "wrong"}).status_code == 401
        )
    assert client.post("/api/auth/login", json={"username": "admin", "password": "wrong"}).status_code == 429
    assert (
        client.post("/api/auth/login", json={"username": "BOB", "password": "bob-password-long"}).status_code
        == 200
    )


def test_native_signup_returns_token_and_scoped_session(client):
    _, token = invite(client)
    client.headers["Origin"] = "capacitor://localhost"
    response = signup(client, token)
    assert response.status_code == 201
    client.cookies.clear()
    client.headers["Authorization"] = "Bearer " + response.json()["token"]
    assert client.get("/api/auth/me").json()["user"]["username"] == "alice"


def test_invite_uses_configured_origin_not_host_header(client, monkeypatch):
    monkeypatch.setattr(settings(), "public_web_url", "https://mewmo.rental-mgmt.us:9443")
    response = client.post("/api/admin/invitations", headers={"Host": "attacker.invalid"})
    assert response.json()["url"].startswith("https://mewmo.rental-mgmt.us:9443/#invite=")
    monkeypatch.setattr(settings(), "public_web_url", "")
    assert client.post("/api/admin/invitations").status_code == 503


def test_same_user_sign_in_keeps_installation_devices(client, bill_input, db):
    device_id = client.post("/api/devices", json={"platform": "ios", "token": "c" * 64}).json()["id"]
    login_admin(client)
    assert db.get(Device, device_id).active
    item = client.post("/api/items", json=bill_input | {"rules": []}).json()
    stamp = now()
    reminder = Reminder(item_id=item["id"], rule_key="test", fire_at=stamp, next_attempt_at=stamp)
    db.add(reminder)
    db.commit()
    sent = []
    dispatch_one(db, reminder.id, lambda device, _: sent.append(device.id), stamp)
    assert sent == [device_id]
    assert reminder.status == "sent"
