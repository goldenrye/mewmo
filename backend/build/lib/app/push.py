import json
import time
from pathlib import Path
from urllib.parse import urlparse

import httpx
import jwt
from pywebpush import WebPushException, webpush

from .config import settings
from .models import Device


class PushFailure(Exception):
    def __init__(self, code: str, permanent: bool = False):
        self.code = code
        self.permanent = permanent
        super().__init__(code)


def valid_web_endpoint(endpoint: str) -> bool:
    try:
        url = urlparse(endpoint)
        host = url.hostname or ""
        allowed = (
            host == "fcm.googleapis.com"
            or host == "updates.push.services.mozilla.com"
            or host.endswith(".push.services.mozilla.com")
            or host == "web.push.apple.com"
            or host.endswith(".notify.windows.com")
        )
        return bool(
            allowed
            and url.scheme == "https"
            and url.port in (None, 443)
            and not url.username
            and not url.password
            and not url.fragment
        )
    except ValueError:
        return False


def send_push(device: Device, payload: dict):
    config = settings()
    if device.platform == "ios":
        if not all([config.apns_key_path, config.apns_key_id, config.apns_team_id]):
            raise PushFailure("apns_not_configured")
        try:
            key = Path(config.apns_key_path).read_text()
        except OSError:
            # Missing file, wrong mount, or not readable by the container user.
            raise PushFailure("apns_key_unreadable") from None
        token = jwt.encode(
            {"iss": config.apns_team_id, "iat": int(time.time())},
            key,
            algorithm="ES256",
            headers={"kid": config.apns_key_id},
        )
        host = "api.sandbox.push.apple.com" if config.apns_sandbox else "api.push.apple.com"
        headers = {
            "authorization": f"bearer {token}",
            "apns-topic": config.apns_topic,
            "apns-push-type": "alert",
            "apns-priority": "10",
            "apns-expiration": "0",
            "apns-id": payload["reminder_id"],
        }
        # No apns-collapse-id or thread-id: every reminder remains separate.
        body = {
            "aps": {"alert": {"title": payload["title"], "body": payload["body"]}, "sound": "default"},
            "item_id": payload["item_id"],
            "reminder_id": payload["reminder_id"],
        }
        with httpx.Client(http2=True, timeout=10) as client:
            response = client.post(
                f"https://{host}/3/device/{device.subscription['token']}", headers=headers, json=body
            )
        if response.status_code != 200:
            reason = (
                response.json().get("reason", "")
                if response.headers.get("content-type", "").startswith("application/json")
                else ""
            )
            permanent = response.status_code == 410 or reason in ("BadDeviceToken", "Unregistered")
            raise PushFailure(f"apns_http_{response.status_code}", permanent)
    else:
        if not config.vapid_private_key:
            raise PushFailure("web_push_not_configured")
        if not valid_web_endpoint(device.subscription["endpoint"]):
            raise PushFailure("invalid_endpoint", permanent=True)
        try:
            webpush(
                subscription_info=device.subscription,
                data=json.dumps(payload),
                vapid_private_key=config.vapid_private_key,
                vapid_claims={"sub": config.vapid_subject},
                ttl=120,
                timeout=10,
            )
        except WebPushException as error:
            status = error.response.status_code if error.response is not None else 0
            raise PushFailure(f"web_push_http_{status}", permanent=status in (404, 410))
