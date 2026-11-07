"""Conservative reminder extraction from untrusted document text."""

import re

from .bill_fields import DATE, MONTH, dates_in_row, labelled_values
from .parsing import ParseFailure, extract_date, parse_bill
from .schemas import Draft, ParseRequest, default_rules, redact_accounts

APPOINTMENT = re.compile(
    r"\b(?:appointment|meeting|dentist|doctor|visit|consultation|interview|reservation|event|concert)\b|"
    r"预约|会议|就诊|面试|活动|演出",
    re.I,
)
DATED = re.compile(
    r"\b(?:reminder|deadline|renewal|renew|expires?|expiration|expiry|return by|due date|birthday)\b|"
    r"提醒|截止|到期|续期|续费|归还|生日",
    re.I,
)
DATE_LABEL = re.compile(
    r"^(?:(?:appointment|meeting|event|visit|start|scheduled)\s+)?date\b[: ]*|"
    r"^(?:when|deadline|due date|expires?|expiration date|expiry date|return by)\b[: ]*|"
    r"^(?:预约日期|会议日期|活动日期|日期|截止日期|到期日期|时间)[：: ]*",
    re.I,
)
TIME_LABEL = re.compile(
    r"\b(?:(?:appointment|meeting|event|start)\s+)?time\b[: ]*|"
    r"(?:预约时间|会议时间|活动时间|时间)[：: ]*",
    re.I,
)
CLOCK = re.compile(
    r"\b\d{1,2}:\d{2}\s*(?:am|pm)?\b|\b\d{1,2}\s*(?:am|pm)\b|"
    r"(?:上午|下午|晚上|早上|中午)?\s*[\d零一二两三四五六七八九十]{1,3}"
    r"(?:点|時|时)(?:[\d零一二三四五六七八九十]{1,3}分?|半)?",
    re.I,
)
RELATIVE = re.compile(
    r"day after tomorrow|tomorrow|today|(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|"
    rf"in \d+ days?|\b(?:{MONTH})\s+\d{{1,2}}\b|"
    r"大后天|后天|明天|今天|下周[一二三四五六日天]|周[一二三四五六日天]|\d+天后|\d{1,2}月\d{1,2}[日号]",
    re.I,
)
METADATA = re.compile(
    r"^(?:(?:sent|printed|created|issued|birth date|date of birth|copyright|confirmation number)\b|"
    r"account(?: number| no\.?)?\s*[:#]|phone\s*:)|"
    r"^(?:发送日期|打印日期|创建日期|出生日期|账号|账户[：:]|电话|编号)",
    re.I,
)
INSTRUCTION = re.compile(r"https?://|ignore\b|instructions?\b|mark\b.*(?:paid|complete)|忽略.*指令", re.I)
TITLE_LABEL = re.compile(r"^(?:title|subject|reminder|appointment|event|主题|标题|事项)\s*[:：]\s*", re.I)
FILE_WARNING = "Review every field. OCR can make mistakes. The original file has been discarded."


def parse_file(text: str, request: ParseRequest) -> Draft:
    try:
        return parse_bill(text, request)
    except ParseFailure:
        pass
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    lines = [line for line in lines if not METADATA.search(line) and not INSTRUCTION.search(line)]
    content = "\n".join(lines)
    kind = "appointment" if APPOINTMENT.search(content) else "dated_item"
    if not (APPOINTMENT.search(content) or DATED.search(content)):
        raise ParseFailure(
            "This file does not contain a recognizable reminder or bill. You can enter an item manually."
        )

    def read_dates(row):
        values = dates_in_row(row)
        for match in RELATIVE.finditer(DATE.sub("", row)):
            day, _, _, _ = extract_date(match[0], request)
            if day:
                values.append(day)
        return values

    def read_times(row):
        values = []
        for match in CLOCK.finditer(row):
            _, clock, _, _ = extract_date(match[0], request)
            if clock:
                values.append(clock)
        return values

    date_pattern = re.compile(f"(?:{DATE.pattern})|(?:{RELATIVE.pattern})", re.I)
    dates, missing_date = labelled_values(lines, DATE_LABEL, read_dates, TIME_LABEL, CLOCK, date_pattern)
    if not any(DATE_LABEL.search(line) for line in lines):
        dates = [day for line in lines for day in read_dates(line)]
    times, missing_time = labelled_values(lines, TIME_LABEL, read_times, DATE_LABEL, date_pattern, CLOCK)
    if not any(TIME_LABEL.search(line) for line in lines):
        times = [clock for line in lines for clock in read_times(line)]
    days, clocks = set(dates), set(times)
    day = next(iter(days)) if len(days) == 1 else None
    clock = next(iter(clocks)) if len(clocks) == 1 else None
    titles = []
    for line in lines[:12]:
        explicit = TITLE_LABEL.match(line)
        if explicit or APPOINTMENT.search(line) or DATED.search(line):
            if DATE_LABEL.search(line) or TIME_LABEL.match(line):
                continue
            candidate = line[explicit.end() :] if explicit else line
            candidate = CLOCK.sub("", date_pattern.sub("", candidate)).strip(" :：,-")
            candidate = re.sub(r"^(?:有|提醒我)", "", candidate)
            if candidate:
                titles.append(redact_accounts(candidate)[:180])
    return Draft(
        local_date=request.local_date,
        timezone=request.timezone,
        source="file",
        kind=kind,
        title=next(iter(titles), "Imported reminder"),
        due_date=day,
        due_time=clock or ("09:00" if kind == "dated_item" and not clocks else None),
        status="open",
        rules=default_rules(kind),
        uncertain=["title", "kind"]
        + (["due_date"] if day is None or missing_date else [])
        + (["due_time"] if clock is None or missing_time else []),
        warnings=[FILE_WARNING],
    )
