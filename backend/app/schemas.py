import re
from datetime import UTC, date, datetime, time
from decimal import Decimal
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, Field, field_validator, model_validator

Kind = Literal["appointment", "bill", "dated_item"]
State = Literal["open", "paid", "completed"]


def redact_accounts(value: str) -> str:
    # Never persist long digit sequences, including spaced or hyphenated account numbers.
    return re.sub(r"\d(?:[\d -]*\d){4,}", lambda m: "****" + re.sub(r"\D", "", m[0])[-4:], value)


def zoned_datetime(day: date, clock: time, timezone: str) -> datetime:
    zone = ZoneInfo(timezone)
    naive = datetime.combine(day, clock)
    result = naive.replace(tzinfo=zone)
    if result.astimezone(UTC).astimezone(zone).replace(tzinfo=None) != naive:
        raise ValueError("This time does not exist because of daylight saving. Choose another time.")
    if result.utcoffset() != result.replace(fold=1).utcoffset():
        raise ValueError("This time occurs twice because of daylight saving. Choose an unambiguous time.")
    return result


class ReminderRule(BaseModel):
    mode: Literal["before", "day"] = "before"
    minutes: int = Field(default=60, ge=0, le=525600)
    days: int = Field(default=0, ge=-365, le=365)
    at: str = Field(default="09:00", pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")

    def key(self) -> str:
        return f"before:{self.minutes}" if self.mode == "before" else f"day:{self.days}:{self.at}"


def default_rules(kind: str) -> list[ReminderRule]:
    if kind == "appointment":
        return [ReminderRule(minutes=1440), ReminderRule(minutes=60)]
    rules = [ReminderRule(minutes=10080), ReminderRule(minutes=1440), ReminderRule(mode="day", days=0)]
    if kind == "bill":
        rules.append(ReminderRule(mode="day", days=1))
    return rules


class Context(BaseModel):
    local_date: date
    timezone: str = Field(max_length=80)

    @field_validator("timezone")
    @classmethod
    def valid_zone(cls, value):
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError("Use a valid IANA time zone")
        return value


class ParseRequest(Context):
    text: str = Field(min_length=1, max_length=4000)


class Draft(Context):
    kind: Kind = "dated_item"
    title: str = ""
    payee: str | None = None
    amount: Decimal | None = None
    currency: str | None = None
    account_last4: str | None = None
    due_date: date | None = None
    due_time: str | None = None
    status: State = "open"
    uncertain: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    duplicates: list[str] = Field(default_factory=list)
    rules: list[ReminderRule] = Field(default_factory=list)
    source: Literal["text", "file", "manual"] = "text"


class ItemInput(Context):
    confirmed: Literal[True]
    kind: Kind
    title: str = Field(min_length=1, max_length=180)
    payee: str | None = Field(default=None, max_length=180)
    amount: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=2)
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    account_last4: str | None = Field(default=None, pattern=r"^\d{4}$")
    due_date: date
    due_time: str = Field(pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")
    status: State = "open"
    rules: list[ReminderRule] | None = Field(default=None, max_length=20)

    @field_validator("title", "payee")
    @classmethod
    def clean_text(cls, value):
        if value is None:
            return None
        value = redact_accounts(value.strip())
        if not value:
            raise ValueError("This field cannot be empty")
        return value

    @model_validator(mode="after")
    def valid_item(self):
        if self.kind == "bill" and (self.amount is None or not self.currency or not self.payee):
            raise ValueError("Bills require a payee, amount, and currency")
        if self.kind == "bill" and self.status == "completed":
            raise ValueError("Use paid for bills")
        if self.kind != "bill" and self.status == "paid":
            raise ValueError("Only bills can be paid")
        zoned_datetime(self.due_date, time.fromisoformat(self.due_time), self.timezone)
        if self.rules is not None and len({r.key() for r in self.rules}) != len(self.rules):
            raise ValueError("Remove duplicate reminder rules")
        return self

    def due_at(self) -> datetime:
        return zoned_datetime(self.due_date, time.fromisoformat(self.due_time), self.timezone).astimezone(UTC)


class StateInput(BaseModel):
    status: State


class LoginInput(BaseModel):
    password: str = Field(min_length=1, max_length=512)
