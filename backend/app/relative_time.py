"""Elapsed-time reminders, resolved before optional AI interpretation."""

import re
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from .schemas import ParseRequest, zoned_datetime

NUMBER = r"(?:-?\d+(?:\.\d+)?|[零一二两三四五六七八九十]+|半)"
EN_DURATION = r"-?\d+(?:\.\d+)?\s*(?:minutes?|mins?|hours?|hrs?)"
RELATIVE_TIME = re.compile(
    rf"(?<![A-Za-z0-9.])(?:in|after)\s+(?P<before>{EN_DURATION})(?![A-Za-z])|"
    rf"(?<![A-Za-z0-9.])(?P<after>{EN_DURATION})\s+(?:later|from now)(?![A-Za-z])|"
    rf"(?<![\d.])(?P<zh>{NUMBER})\s*(?:个)?(?P<unit>分钟|分鐘|小时|小時)\s*(?:之)?后",
    re.I,
)
RELATIVE_ERROR = "Could not resolve this relative time. Enter an exact date and time."
ROUNDING_NOTE = "Relative reminder times are rounded up to the next minute."


def number(value: str) -> Decimal:
    if value == "半":
        return Decimal("0.5")
    if re.fullmatch(r"-?\d+(?:\.\d+)?", value):
        return Decimal(value)
    digits = {char: i for i, char in enumerate("零一二三四五六七八九")} | {"两": 2}
    if "十" in value:
        before, after = value.split("十", 1)
        if (before and before not in digits) or (after and after not in digits):
            raise ValueError(RELATIVE_ERROR)
        return Decimal(digits.get(before, 1) * 10 + digits.get(after, 0))
    if value not in digits:
        raise ValueError(RELATIVE_ERROR)
    return Decimal(digits[value])


def relative_time(request: ParseRequest):
    matches = list(RELATIVE_TIME.finditer(request.text))
    if not matches:
        return None
    if len(matches) != 1:
        raise ValueError(RELATIVE_ERROR)
    match = matches[0]
    if match["zh"]:
        amount = number(match["zh"])
        hours = match["unit"] in ("小时", "小時")
    else:
        value = match["before"] or match["after"]
        amount = number(re.match(r"-?\d+(?:\.\d+)?", value)[0])
        hours = bool(re.search(r"hours?|hrs?", value, re.I))
    minutes = amount * (60 if hours else 1)
    if not 0 < minutes <= 525600:
        raise ValueError(RELATIVE_ERROR)
    # Do not silently interpret the first part of a compound duration.
    tail = request.text[match.end() :]
    outside = request.text[: match.start()] + tail
    if re.search(rf"(?:{EN_DURATION})|(?:{NUMBER})\s*(?:个)?(?:小时|小時|分钟|分鐘)", outside, re.I):
        raise ValueError(RELATIVE_ERROR)
    base = request.client_now or datetime.now(UTC)
    try:
        target = base.astimezone(UTC) + timedelta(seconds=float(minutes * 60))
        rounded = bool(target.second or target.microsecond)
        if rounded:
            target += timedelta(minutes=1)
        target = target.replace(second=0, microsecond=0).astimezone(ZoneInfo(request.timezone))
    except OverflowError:
        raise ValueError(RELATIVE_ERROR) from None
    # The editor cannot represent DST folds; require an explicit unambiguous time.
    zoned_datetime(target.date(), target.time().replace(tzinfo=None), request.timezone)
    title = request.text[: match.start()] + request.text[match.end() :]
    return target.date(), target.strftime("%H:%M"), title, [ROUNDING_NOTE] if rounded else []
