"""Local, bounded field matching for OCR and layout-preserving PDF text."""

import re
from datetime import date

import dateparser

MONTH = (
    r"jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|"
    r"aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?"
)
DATE = re.compile(
    rf"\b(?:{MONTH})\.?\s+\d{{1,2}},?\s+20\d{{2}}\b|"
    rf"\b\d{{1,2}}\s+(?:{MONTH})\.?,?\s+20\d{{2}}\b|"
    r"\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b|"
    r"20\d{2}年\d{1,2}月\d{1,2}[日号]?|"
    r"\b\d{1,2}[/-]\d{1,2}[/-]20\d{2}\b",
    re.I,
)
DUE_LABEL = re.compile(r"\b(?:due date|payment due(?: date)?|pay by)\b|到期日|截止日期|缴费截止", re.I)
TOTAL_LABEL = re.compile(
    r"\b(?:total amount due|total due|amount due|balance due)\b|应付金额|应付|合计", re.I
)
PAYEE_LABEL = re.compile(
    r"^(?:(?:payee|biller|vendor|supplier|issued by)\b|收款人|收款方|商户|供应商)[ \t]*[:：]?[ \t]*",
    re.I,
)
ACCOUNT_LABEL = re.compile(
    r"\baccount(?:[ \t]+(?:number\b|no\b\.?))?[ \t]*[:：#]?[ \t]*|"
    r"(?:账号|账户)[ \t]*[:：]?[ \t]*",
    re.I,
)
# A nearby date or price is not necessarily the value of the preceding label.
OTHER_FIELD = re.compile(
    r"\b(?:previous|prior|credits?|payments? received|balance forward|bill(?:ing)? period|"
    r"bill creation|invoice date|statement date|issue date|account|autopay|auto.pay|"
    r"scheduled|exp(?:iry)?|visa|mastercard|pay now|total recurring|recurring activity)\b|"
    r"账期|开票日期|出账日期|上期|自动扣款|卡号",
    re.I,
)


def labelled_values(lines, label, read_values, companion=None, skip_pattern=None, value_pattern=None):
    """Read a label's row or at most three following rows, never the whole bill."""
    found = []
    unresolved = False
    for index, line in enumerate(lines):
        for match in label.finditer(line):
            if OTHER_FIELD.search(line[: match.start()]):
                continue
            tail = line[match.end() :].strip(" \t:：")
            rows = [tail, *lines[index + 1 : index + 4]]
            resolved = False
            for offset, row in enumerate(rows):
                # Paired column headers can share a row before their values.
                clean = companion.sub("", row) if companion else row
                if OTHER_FIELD.search(clean):
                    break
                values = read_values(row)
                if offset and value_pattern:
                    remainder = DATE.sub("", clean)
                    if skip_pattern:
                        remainder = skip_pattern.sub("", remainder)
                    remainder = value_pattern.sub("", remainder)
                    if remainder.strip(" \t:：|-_"):
                        break
                if values:
                    found.extend(values)
                    resolved = True
                    break
                if skip_pattern:
                    clean = skip_pattern.sub("", clean)
                if clean.strip(" \t:：|-_") or offset == 3:
                    break
            unresolved |= not resolved
    return found, unresolved


def dates_in_row(row: str) -> list[date]:
    values = []
    for match in DATE.finditer(row):
        text = match[0]
        numeric = re.fullmatch(r"(\d{1,2})[/-](\d{1,2})[/-](20\d{2})", text)
        if numeric:
            first, second, year = map(int, numeric.groups())
            # Do not silently pick US or day-first ordering from the user's zone.
            for month, day in {(first, second), (second, first)}:
                try:
                    values.append(date(year, month, day))
                except ValueError:
                    pass
        else:
            parsed = dateparser.parse(
                text,
                languages=["en", "zh"],
                settings={"STRICT_PARSING": True, "DATE_ORDER": "YMD"}
                if re.match(r"20\d{2}", text)
                else {"STRICT_PARSING": True},
            )
            if parsed:
                values.append(parsed.date())
    return values


def clean_payee(value: str) -> str | None:
    value = re.split(r"\t| {2,}", value.strip())[0].strip(" :：")
    if (
        not 2 <= len(value) <= 180
        or OTHER_FIELD.search(value)
        or DUE_LABEL.search(value)
        or TOTAL_LABEL.search(value)
        or re.search(r"https?://|@|[<>]|ignore\b|instructions?\b|mark\b.*paid\b", value, re.I)
        or re.fullmatch(r"[\W\d_]+", value)
    ):
        return None
    return value


def payee_from_lines(lines: list[str]) -> tuple[str | None, bool]:
    explicit = []
    for index, line in enumerate(lines):
        match = PAYEE_LABEL.match(line)
        if match:
            value = line[match.end() :].strip() or next(iter(lines[index + 1 : index + 2]), "")
            if candidate := clean_payee(value):
                explicit.append(candidate)
    candidates = {value.casefold(): value for value in explicit}
    if candidates:
        return (next(iter(candidates.values())), False) if len(candidates) == 1 else (None, True)

    suggestions = []
    # This phrase survives OCR even when the issuer's name is only a logo.
    for match in re.finditer(
        r"\bvalued[ \t]+([^\n]{2,80}?)(?:\n[ \t]*)?[ \t]*customer\b",
        "\n".join(lines),
        re.I,
    ):
        if candidate := clean_payee(match[1]):
            suggestions.append(candidate)
    # Only short company-like headers near the start qualify, not arbitrary prose.
    for line in lines[:8]:
        value = clean_payee(line)
        if (
            value
            and len(value.split()) <= 8
            and re.fullmatch(
                r"[A-Za-z\u4e00-\u9fff][\w &.'’\-]{1,70}"
                r"(?:\b(?:Inc\.?|LLC|Ltd\.?|Company|Co\.?|Utilities|Telecom|Mobile)|有限公司|供电公司)",
                value,
                re.I,
            )
        ):
            suggestions.append(value)
    candidates = {value.casefold(): value for value in suggestions}
    return (next(iter(candidates.values())), True) if len(candidates) == 1 else (None, True)


def account_from_lines(lines: list[str]) -> str | None:
    def read_account(row):
        match = re.fullmatch(r"[\d*xX•][\d*xX• \-]{3,60}", row.strip())
        digits = re.sub(r"\D", "", match[0]) if match else ""
        return [digits[-4:]] if len(digits) >= 4 else []

    values, _ = labelled_values(lines, ACCOUNT_LABEL, read_account)
    return values[0] if len(set(values)) == 1 else None
