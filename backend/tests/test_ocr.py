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
