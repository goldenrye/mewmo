"""Shared resource limits and image consent for reminder and note imports."""

import threading

from fastapi import HTTPException, Request

from .model_settings import image_chain_token
from .models import ModelPreference

ocr_slots = threading.BoundedSemaphore(2)


async def read_upload(request: Request) -> bytearray:
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > 12 * 1024 * 1024:
            raise HTTPException(413, "Files must be no larger than 12 MB.")
        data.extend(chunk)
    return data


def validate_image_consent(
    preference: ModelPreference | None,
    use_image_ai: bool,
    provider: str | None,
    revision: int | None,
    chain: str | None,
):
    if not use_image_ai:
        return
    if not (preference and preference.enabled and preference.allow_images):
        raise HTTPException(400, "Enable image analysis in AI settings before using it for an import.")
    if provider != preference.provider or (
        (preference.fallbacks and chain != image_chain_token(preference))
        or (chain is not None and chain != image_chain_token(preference))
        or (revision is not None and revision != preference.revision)
    ):
        raise HTTPException(400, "AI settings changed. Review them and opt in to image analysis again.")
