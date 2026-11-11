"""Fixed provider endpoints only. No custom URLs, redirects, tools, or raw errors."""

import json
import threading

import httpx

slots = threading.BoundedSemaphore(4)


class ModelUnavailable(ValueError):
    pass


def request_model(
    provider: str, model: str, key: str, system: str, prompt: str, images=(), *,
    timeout=30, max_output_tokens=1600,
) -> str:
    text = {"type": "text", "text": prompt}
    if provider in ("openai", "doubao"):
        url = (
            "https://api.openai.com/v1/chat/completions"
            if provider == "openai"
            else "https://ark.cn-beijing.volces.com/api/v3/chat/completions"
        )
        headers = {"Authorization": f"Bearer {key}"}
        content = [
            text,
            *[
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image}"}}
                for image in images
            ],
        ]
        body = {
            "model": model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": content}],
            "response_format": {"type": "json_object"},
        }
        if provider == "openai":
            body.update(max_completion_tokens=max_output_tokens, store=False)
        else:
            # Ark uses its own output budget and reasoning controls, not OpenAI's store option.
            body.update(max_tokens=max_output_tokens, thinking={"type": "disabled"})
    elif provider == "anthropic":
        url = "https://api.anthropic.com/v1/messages"
        headers = {"x-api-key": key, "anthropic-version": "2023-06-01"}
        content = [
            text,
            *[
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": image}}
                for image in images
            ],
        ]
        body = {
            "model": model,
            "system": system,
            "messages": [{"role": "user", "content": content}],
            "max_tokens": max_output_tokens,
        }
    elif provider == "gemini":
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        headers = {"x-goog-api-key": key}
        body = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {"text": prompt},
                        *[{"inlineData": {"mimeType": "image/png", "data": image}} for image in images],
                    ],
                }
            ],
            "generationConfig": {"maxOutputTokens": max_output_tokens, "responseMimeType": "application/json"},
        }
    else:
        raise ModelUnavailable()
    if not slots.acquire(blocking=False):
        raise ModelUnavailable()
    try:
        # Avoid environment proxies and redirects leaking the user's API key.
        with httpx.Client(
            timeout=httpx.Timeout(timeout, connect=min(5, timeout)), trust_env=False, follow_redirects=False
        ) as client:
            with client.stream("POST", url, headers=headers, json=body) as response:
                if response.status_code != 200:
                    raise ModelUnavailable()
                data = bytearray()
                for chunk in response.iter_bytes():
                    data.extend(chunk)
                    if len(data) > 65536:
                        raise ModelUnavailable()
        result = json.loads(data)
        if provider in ("openai", "doubao"):
            choice = result["choices"][0]
            if choice.get("finish_reason") != "stop" or choice["message"].get("tool_calls"):
                raise ModelUnavailable()
            output = choice["message"]["content"]
        elif provider == "anthropic":
            if result.get("stop_reason") != "end_turn":
                raise ModelUnavailable()
            output = "".join(part["text"] for part in result["content"] if part["type"] == "text")
        else:
            candidate = result["candidates"][0]
            if candidate.get("finishReason") != "STOP":
                raise ModelUnavailable()
            output = "".join(part.get("text", "") for part in candidate["content"]["parts"])
        if not isinstance(output, str) or not output.strip() or len(output) > 12000:
            raise ModelUnavailable()
        return output
    except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError, AttributeError):
        raise ModelUnavailable() from None
    finally:
        slots.release()
