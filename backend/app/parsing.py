"""Conservative local parsers. No tool execution, model actions, or database writes."""

import re
import subprocess
import tempfile
import warnings
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path

import dateparser
from PIL import Image, ImageOps
from pillow_heif import register_heif_opener

from .bill_fields import (
    DATE,
    DUE_LABEL,
    TOTAL_LABEL,
    account_from_lines,
    dates_in_row,
    labelled_values,
    payee_from_lines,
)
from .schemas import Draft, ParseRequest, default_rules, redact_accounts

register_heif_opener()

CURRENCY = r"USD|CAD|AUD|CNY|RMB|EUR|GBP|HKD|JPY|US dollars?|Canadian dollars?|Australian dollars?|dollars?|euros?|pounds?|yuan|美元|加元|澳元|人民币|港币|刀|元|[$€£¥]"
MONEY = re.compile(
    rf"(?:(?P<prefix>{CURRENCY})\s*(?P<a>\d[\d,]*(?:\.\d{{1,2}})?)|"
    rf"(?P<b>\d[\d,]*(?:\.\d{{1,2}})?)\s*(?P<suffix>{CURRENCY}))",
    re.I,
)
CURRENCIES = {
    "$": "USD",
    "刀": "USD",
    "美元": "USD",
    "加元": "CAD",
    "澳元": "AUD",
    "元": "CNY",
    "人民币": "CNY",
    "RMB": "CNY",
    "¥": "CNY",
    "€": "EUR",
    "£": "GBP",
    "港币": "HKD",
    "DOLLAR": "USD",
    "DOLLARS": "USD",
    "US DOLLAR": "USD",
    "US DOLLARS": "USD",
    "CANADIAN DOLLAR": "CAD",
    "CANADIAN DOLLARS": "CAD",
    "AUSTRALIAN DOLLAR": "AUD",
    "AUSTRALIAN DOLLARS": "AUD",
    "EURO": "EUR",
    "EUROS": "EUR",
    "POUND": "GBP",
    "POUNDS": "GBP",
    "YUAN": "CNY",
}


def clock_number(value: str) -> int:
    if value.isdigit():
        return int(value)
    digits = {c: i for i, c in enumerate("零一二三四五六七八九")} | {"两": 2}
    if "十" in value:
        before, after = value.split("十", 1)
        return digits.get(before, 1) * 10 + digits.get(after, 0)
    return digits.get(value, 0)


def extract_date(text: str, request: ParseRequest):
    day = None
    clock = None
    remainder = text
    uncertain = []
    relative = re.search(r"大后天|后天|明天|今天|day after tomorrow|tomorrow|today", text, re.I)
    explicit = re.search(
        r"\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b|"
        r"(20\d{2})年(\d{1,2})月(\d{1,2})[日号]?",
        text,
    )
    if explicit:
        parts = explicit.groups()[:3] if explicit[1] else explicit.groups()[3:]
        try:
            day = datetime(*map(int, parts)).date()
        except ValueError:
            uncertain.append("due_date")
        remainder = remainder.replace(explicit[0], "")
    elif relative:
        offset = {
            "大后天": 3,
            "后天": 2,
            "明天": 1,
            "今天": 0,
            "day after tomorrow": 2,
            "tomorrow": 1,
            "today": 0,
        }[relative[0].lower()]
        day = request.local_date + timedelta(days=offset)
        remainder = remainder.replace(relative[0], "")
    else:
        date_match = re.search(
            r"(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|"
            r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|"
            r"aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,?\s+20\d{2})?|"
            r"\d{1,2}月\d{1,2}[日号]|下周[一二三四五六日天]|周[一二三四五六日天]|"
            r"in \d+ days?|\d+天后",
            text,
            re.I,
        )
        if date_match:
            value = date_match[0]
            if "周" in value:
                weekday = "一二三四五六日".index(value[-1].replace("天", "日"))
                offset = weekday - request.local_date.weekday()
                if value.startswith("下") or offset < 0:
                    offset += 7
                day = request.local_date + timedelta(days=offset)
            elif "月" in value:
                month, day_number = map(int, re.findall(r"\d+", value))
                try:
                    day = request.local_date.replace(month=month, day=day_number)
                    if day < request.local_date:
                        day = day.replace(year=day.year + 1)
                except ValueError:
                    uncertain.append("due_date")
            else:
                parsed = dateparser.parse(
                    value,
                    languages=["en", "zh"],
                    settings={
                        "RELATIVE_BASE": datetime.combine(request.local_date, datetime.min.time()),
                        "PREFER_DATES_FROM": "future",
                        "TIMEZONE": request.timezone,
                    },
                )
                day = parsed.date() if parsed else None
            remainder = remainder.replace(value, "")
    tm = re.search(
        r"(?:(上午|下午|晚上|早上|中午)\s*)?([\d零一二两三四五六七八九十]{1,3})(?:点|時|时)(?:([\d零一二三四五六七八九十]{1,3})分?|半)?",
        remainder,
    )
    if tm:
        hour, minute = clock_number(tm[2]), clock_number(tm[3]) if tm[3] else (30 if "半" in tm[0] else 0)
        if tm[1] in ("下午", "晚上", "中午") and hour < 12:
            hour += 12
        if tm[1] in ("上午", "早上") and hour == 12:
            hour = 0
    else:
        tm = re.search(r"\b(?:at\s+)?(\d{1,2})(?::(\d{2})\s*(am|pm)?|\s*(am|pm))\b", remainder, re.I)
        if tm:
            hour, minute = int(tm[1]), int(tm[2] or 0)
            meridiem = (tm[3] or tm[4] or "").lower()
            if meridiem:
                hour = hour % 12 + (12 if meridiem == "pm" else 0)
    if tm:
        if 0 <= hour <= 23 and 0 <= minute <= 59:
            clock = f"{hour:02}:{minute:02}"
        remainder = remainder.replace(tm[0], "")
    return day, clock, remainder, uncertain


def parse_text(request: ParseRequest) -> Draft:
    text = request.text.strip()
    money = MONEY.search(text)
    is_bill = bool(
        money
        or re.search(r"\b(?:bill|invoice|rent|paid|unpaid|utility)\b|电费|水电|账单|房租|已付", text, re.I)
    )
    appointment = re.search(r"appointment|meeting|dentist|doctor|预约|会议|看医生", text, re.I)
    kind = "bill" if is_bill else "appointment" if appointment else "dated_item"
    day, clock, title, uncertain = extract_date(text, request)
    draft = Draft(
        local_date=request.local_date,
        timezone=request.timezone,
        kind=kind,
        due_date=day,
        due_time=clock or ("09:00" if kind != "appointment" else None),
        uncertain=uncertain,
        rules=default_rules(kind),
    )
    if money:
        symbol = (money["prefix"] or money["suffix"]).upper()
        try:
            draft.amount = Decimal((money["a"] or money["b"]).replace(",", ""))
        except InvalidOperation:
            draft.uncertain.append("amount")
        draft.currency = CURRENCIES.get(symbol, symbol)
        if symbol in ("$", "刀", "¥", "元", "DOLLAR", "DOLLARS"):
            draft.uncertain.append("currency")
            draft.warnings.append(f"Please confirm the currency; interpreted {symbol} as {draft.currency}.")
        title = title.replace(money[0], "")
    if re.search(r"已付|已支付|已缴|(?<!un)\bpaid\b", text, re.I) and not re.search(
        r"\bnot paid\b|未付", text, re.I
    ):
        draft.status = "paid" if kind == "bill" else "completed"
    title = re.sub(
        r"这个月|本月|已付|已支付|已缴|(?<!un)\bpaid\b|"
        r"\b(?:remind me to|remind me|on|at|due|this month)\b",
        "",
        title,
        flags=re.I,
    )
    title = re.sub(r"^[\s,，。:：;；]*(?:有|提醒我)?", "", title).strip(" ,，。:：;；")
    draft.title = redact_accounts(title)[:180]
    if kind == "bill":
        draft.payee = draft.title or None
        draft.uncertain.append("payee")
    if not day:
        draft.uncertain.append("due_date")
    if not draft.due_time:
        draft.uncertain.append("due_time")
    if not draft.title:
        draft.uncertain.append("title")
    if kind == "bill":
        draft.uncertain += [field for field in ("amount", "currency") if getattr(draft, field) is None]
    draft.uncertain = list(dict.fromkeys(draft.uncertain))
    return draft


class ParseFailure(ValueError):
    pass


def run_tool(args: list[str], timeout: int = 25) -> str:
    try:
        result = subprocess.run(args, capture_output=True, timeout=timeout, check=True)
        return result.stdout.decode("utf-8", errors="replace")
    except FileNotFoundError:
        raise ParseFailure("Local OCR is unavailable. Please enter this item manually.")
    except (subprocess.SubprocessError, OSError):
        raise ParseFailure("We could not read this file. Try a clearer image or enter it manually.")


def ocr_image(path: Path) -> str:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as image:
                if image.width * image.height > 25_000_000:
                    raise ParseFailure("Image is too large. Use an image under 25 megapixels.")
                normalized = ImageOps.exif_transpose(image).convert("RGB")
                normalized.thumbnail((3200, 3200))
                normalized.save(path.with_suffix(".png"))
        return run_tool(
            [
                "tesseract",
                str(path.with_suffix(".png")),
                "stdout",
                "-l",
                "eng+chi_sim",
                "-c",
                "preserve_interword_spaces=1",
            ]
        )
    except (OSError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise ParseFailure("This image cannot be read. Please use JPEG, PNG, HEIC, or WebP.")


def extract_file(data: bytes) -> str:
    # All bytes and OCR intermediates are ephemeral, including failure paths.
    with tempfile.TemporaryDirectory(prefix="mewmo-") as directory:
        root = Path(directory)
        if data.startswith(b"%PDF-"):
            source = root / "source.pdf"
            source.write_bytes(data)
            info = run_tool(["pdfinfo", str(source)])
            pages = re.search(r"Pages:\s+(\d+)", info)
            if not pages or int(pages[1]) > 5:
                raise ParseFailure("Please import a PDF with at most 5 pages.")
            text = run_tool(["pdftotext", "-layout", str(source), "-"])
            if len(re.sub(r"\s", "", text)) < 40:
                run_tool(["pdftoppm", "-scale-to", "2200", "-png", str(source), str(root / "page")], 45)
                text = "\n".join(ocr_image(page) for page in sorted(root.glob("page-*.png")))
        else:
            source = root / "source.image"
            source.write_bytes(data)
            text = ocr_image(source)
    if len(text.strip()) < 8:
        raise ParseFailure("No readable text was found. Try a clearer scan or enter the item manually.")
    return text[:40000]


def parse_bill(text: str, request: ParseRequest) -> Draft:
    if not re.search(
        r"\b(?:invoice|bill|amount due|total due|payment due)\b|账单|发票|应付|缴费", text, re.I
    ):
        raise ParseFailure("This does not look like a bill. You can still enter an item manually.")
    draft = Draft(
        local_date=request.local_date,
        timezone=request.timezone,
        kind="bill",
        source="file",
        rules=default_rules("bill"),
        due_time="09:00",
    )
    lines = [line.strip() for line in text.replace("\r", "\n").splitlines() if line.strip()]
    payee, inferred = payee_from_lines(lines)
    if payee:
        draft.payee = draft.title = redact_accounts(payee)
        if inferred:
            draft.uncertain += ["payee", "title"]
    else:
        draft.title = "Imported bill"
        draft.uncertain += ["payee", "title"]

    def amounts_in_row(row):
        # Otherwise a year followed by a currency in the next column looks like money.
        row = DATE.sub("", row)
        values = []
        for match in MONEY.finditer(row):
            symbol = (match["prefix"] or match["suffix"]).upper()
            number = match["a"] or match["b"]
            amount = Decimal(number.replace(",", ""))
            before, after = row[: match.start()].rstrip(), row[match.end() :]
            if (
                before.endswith(("-", "−", "("))
                or after.startswith((")", ".", ","))
                or (after and after[0].isdigit())
                or not re.fullmatch(r"(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?", number)
                or amount > Decimal("999999999999.99")
            ):
                values.append((None, None, True))
            else:
                values.append(
                    (
                        amount,
                        CURRENCIES.get(symbol, symbol),
                        symbol in ("$", "刀", "¥", "元", "DOLLAR", "DOLLARS"),
                    )
                )
        return values

    amounts, unresolved = labelled_values(
        lines,
        TOTAL_LABEL,
        amounts_in_row,
        DUE_LABEL,
        DATE,
        MONEY,
    )
    unique_amounts = {(amount, currency) for amount, currency, _ in amounts}
    if len(unique_amounts) == 1 and amounts[0][0] is not None:
        draft.amount, draft.currency = next(iter(unique_amounts))
        if unresolved:
            draft.uncertain.append("amount")
        if unresolved or all(ambiguous for _, _, ambiguous in amounts):
            draft.uncertain.append("currency")
    else:
        draft.uncertain += ["amount", "currency"]

    dates, unresolved = labelled_values(
        lines,
        DUE_LABEL,
        dates_in_row,
        TOTAL_LABEL,
        MONEY,
        DATE,
    )
    if len(set(dates)) == 1:
        draft.due_date = dates[0]
    if not draft.due_date or unresolved:
        draft.uncertain.append("due_date")
    draft.account_last4 = account_from_lines(lines)
    draft.warnings.append("Review every field. OCR can make mistakes. The original file has been discarded.")
    return draft
