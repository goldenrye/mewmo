"""Real local OCR tests, skipped only when system binaries are unavailable."""

import shutil

import pytest
from PIL import Image, ImageDraw, ImageFont

from app.parsing import extract_file, parse_bill
from app.schemas import ParseRequest

pytestmark = pytest.mark.skipif(
    not all(shutil.which(tool) for tool in ("tesseract", "pdftotext", "pdftoppm", "pdfinfo")),
    reason="Install Tesseract (eng+chi_sim) and Poppler for real OCR tests",
)


@pytest.mark.parametrize("format", ["PNG", "PDF", "HEIF"])
def test_real_scan_photo_and_pdf(tmp_path, format):
    image = Image.new("RGB", (1600, 1100), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=42)
    lines = [
        "INVOICE",
        "Payee: Utility Company",
        "Amount due: USD 120.50",
        "Due date: 2026-11-20",
        "Account: 1234 5678 9999",
    ]
    for index, line in enumerate(lines):
        draw.text((90, 100 + index * 130), line, fill="black", font=font)
    path = tmp_path / f"scan.{format.lower()}"
    image.save(path, format=format)
    text = extract_file(path.read_bytes())
    draft = parse_bill(text, ParseRequest(text="file", local_date="2026-11-06", timezone="UTC"))
    assert draft.title == "Utility Company"
    assert str(draft.amount) == "120.50"
    assert str(draft.due_date) == "2026-11-20"
    assert draft.account_last4 == "9999"
    assert "1234" not in draft.model_dump_json()


@pytest.mark.parametrize("format", ["PNG", "PDF", "HEIF"])
def test_real_two_column_bill(tmp_path, format):
    image = Image.new("RGB", (1800, 1400), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=38)
    draw.text((90, 70), "Boost Mobile", fill="black", font=font)
    draw.text((90, 150), "BILL", fill="black", font=font)
    draw.text((90, 280), "Due date", fill="black", font=font)
    draw.text((1000, 280), "Amount due", fill="black", font=font)
    draw.text((90, 360), "NOV 12, 2026", fill="black", font=font)
    draw.text((1000, 360), "$61.78", fill="black", font=font)
    for index, line in enumerate(
        [
            "Account number: 1000 2222 4444",
            "Previous bill: $61.77",
            "Payments & credits: -$61.77",
            "Autopay on Nov 12, 2026: $61.78",
            "Total amount due: $61.78",
        ]
    ):
        draw.text((90, 550 + index * 130), line, fill="black", font=font)
    path = tmp_path / f"columns.{format.lower()}"
    image.save(path, format=format)
    text = extract_file(path.read_bytes())
    draft = parse_bill(text, ParseRequest(text="file", local_date="2026-11-06", timezone="UTC"))
    assert draft.payee == "Boost Mobile"
    assert str(draft.amount) == "61.78"
    assert str(draft.due_date) == "2026-11-12"
    assert draft.account_last4 == "4444"
    assert draft.status == "open"
