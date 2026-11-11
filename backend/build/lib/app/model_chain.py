"""Try configured models in order, without merging partial/invalid responses."""

from collections.abc import Callable
from typing import TypeVar

from pydantic import ValidationError

from .model_provider import ModelUnavailable
from .model_settings import ordered_models
from .models import ModelFallback, ModelPreference

T = TypeVar("T")
BACKUP_WARNING = "A backup AI model was used because an earlier model was unavailable."


def try_models(preference: ModelPreference, attempt: Callable[[ModelPreference | ModelFallback], T]):
    for index, model in enumerate(ordered_models(preference)[:5]):
        try:
            return attempt(model), index
        except (ModelUnavailable, ValidationError):
            continue
    raise ModelUnavailable()


def attempt_timeout(preference: ModelPreference):
    return 15 if preference.fallbacks else 30
