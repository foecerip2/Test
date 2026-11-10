"""Responses API для OAuth-токенов ChatGPT. Использует тот же каталог ServerMind, что и API-ключи."""

from __future__ import annotations

import json
import time
import uuid
from typing import Any

import httpx
from pydantic import ValidationError
from sqlalchemy import select

from app.core.config import get_settings
from app.core.security import DecryptionError, decrypt, encrypt
from app.db.models import AiKey
from app.db.session import _factory
from app.modules.ai import chatgpt_auth, providers
from app.modules.ai.providers import ProviderError, ToolCall, ToolDef, Turn

PROVIDER = "chatgpt"
NAMESPACE = "servermind"
STREAM_LIMIT_BYTES = 4 * 1024 * 1024


def _aad(org_id: uuid.UUID) -> bytes:
    return f"chatgpt-plan:{org_id}".encode()


def encode(session: chatgpt_auth.ChatGPTSession, org_id: uuid.UUID) -> bytes:
    return encrypt(get_settings().master_key_bytes, session.model_dump_json().encode(), _aad(org_id))


def decode(key: AiKey) -> chatgpt_auth.ChatGPTSession:
    try:
        raw = decrypt(get_settings().master_key_bytes, key.key_enc, _aad(key.organization_id))
        return chatgpt_auth.ChatGPTSession.model_validate_json(raw)
    except (DecryptionError, ValidationError):
        raise ProviderError("auth", "Сессия ChatGPT недоступна. Подключите аккаунт заново.") from None


def access_token(key_id: uuid.UUID, user_id: uuid.UUID, org_id: uuid.UUID, timeout: float) -> str:
    # Отдельная транзакция сохраняет обновлённый refresh-токен, даже если запрос модели позже завершится с ошибкой.
    with _factory()() as db:
        key = db.scalar(select(AiKey).where(AiKey.id == key_id, AiKey.organization_id == org_id,
                                            AiKey.created_by == user_id, AiKey.provider == PROVIDER).with_for_update())
        if key is None or key.status == "invalid":
            raise ProviderError("auth", "Подключите аккаунт ChatGPT заново.")
        session = decode(key)
        if session.expires_at <= time.time():
            try:
                session = chatgpt_auth.refresh(session, timeout)
            except ProviderError as error:
                if error.code == "auth":
                    key.status = "invalid"
                    db.commit()
                raise
            key.key_enc = encode(session, org_id)
            db.commit()
        return session.access_token


class ChatGPTPlan:
    def chat(self, *, api_key: str, model: str, system: str, messages: list[dict[str, Any]], tools: list[ToolDef],
             max_tokens: int, timeout: float) -> Turn:
        inputs: list[dict[str, Any]] = []
        for message in messages:
            if message["role"] == "tool":
                inputs.append({"type": "function_call_output", "call_id": message["tool_call_id"], "output": message["content"]})
            elif message.get("response_items"):
                inputs.extend(message["response_items"])
            else:
                inputs.append({"role": message["role"], "content": message["content"]})
        payload: dict[str, Any] = {
            "model": model, "instructions": system, "input": inputs, "store": False, "stream": True,
            "include": ["reasoning.encrypted_content"],
        }
        if tools:
            payload["tools"] = [{
                "type": "namespace", "name": NAMESPACE, "description": "Проверки и планы ServerMind",
                "tools": [{"type": "function", "name": tool.name, "description": tool.description,
                           "parameters": tool.parameters, "strict": False} for tool in tools],
            }]
        completed = self._response(api_key, payload, timeout)
        try:
            text: list[str] = []
            calls: list[ToolCall] = []
            response_items: list[dict[str, Any]] = []
            for item in completed["output"]:
                if item["type"] == "message":
                    text.extend(part["text"] for part in item["content"] if part["type"] == "output_text")
                elif item["type"] == "function_call":
                    name = item["name"] if item.get("namespace") in (None, NAMESPACE) else "unexpected_namespace"
                    calls.append(ToolCall(item["call_id"], name, providers._parse_args(item.get("arguments"))))
                if item["type"] in ("message", "function_call", "reasoning"):
                    response_items.append(item)
            usage = completed.get("usage") or {}
            return Turn("".join(text), calls, int(usage.get("input_tokens", 0)), int(usage.get("output_tokens", 0)), response_items)
        except (KeyError, TypeError, ValueError, AttributeError):
            raise ProviderError("bad_response", "ChatGPT вернул ответ неожиданного формата.") from None

    def _response(self, access: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        total = 0
        try:
            with providers.make_client(timeout) as client, client.stream(
                "POST", f"{chatgpt_auth.RESOURCE}/responses",
                headers={"Authorization": f"Bearer {access}", "Accept": "text/event-stream", "User-Agent": "ServerMind"},
                json=payload,
            ) as response:
                if response.status_code in (401, 403):
                    raise ProviderError("auth", "OpenAI отклонил подписку ChatGPT. Проверьте доступ и войдите заново.")
                if response.status_code == 429:
                    raise ProviderError("rate_limit", "Достигнут лимит подписки ChatGPT.")
                if response.status_code >= 500:
                    raise ProviderError("unavailable", "ChatGPT временно недоступен.")
                if not response.is_success:
                    raise ProviderError("bad_request", "ChatGPT отклонил запрос. Проверьте доступность выбранной модели.")
                for line in response.iter_lines():
                    if time.monotonic() > deadline:
                        raise ProviderError("timeout", "ChatGPT не завершил ответ вовремя.")
                    total += len(line.encode("utf-8"))
                    if total > STREAM_LIMIT_BYTES:
                        raise ProviderError("bad_response", "Ответ ChatGPT превысил допустимый размер.")
                    if not line.startswith("data:") or line[5:].strip() == "[DONE]":
                        continue
                    event = json.loads(line[5:])
                    kind = event.get("type")
                    if kind == "response.completed":
                        return event["response"]
                    if kind in ("error", "response.failed", "response.incomplete"):
                        error = event.get("response", {}).get("error") or event
                        if error.get("code") == "subscription_sharing_usage_limit_exceeded":
                            raise ProviderError("rate_limit", "Достигнут лимит подписки ChatGPT.")
                        raise ProviderError("unavailable", "ChatGPT не смог завершить запрос. Проверьте подписку и модель.")
        except httpx.TimeoutException:
            raise ProviderError("timeout", "ChatGPT не ответил вовремя.") from None
        except httpx.HTTPError:
            raise ProviderError("unavailable", "Не удалось связаться с ChatGPT.") from None
        except (KeyError, ValueError, TypeError, AttributeError):
            raise ProviderError("bad_response", "ChatGPT вернул ответ неожиданного формата.") from None
        raise ProviderError("bad_response", "Поток ChatGPT завершился без подтверждения результата.")
