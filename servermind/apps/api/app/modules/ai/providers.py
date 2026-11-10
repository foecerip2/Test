"""Тонкие адаптеры к ОФИЦИАЛЬНЫМ API провайдеров (OpenAI, Anthropic, DeepSeek). Без LiteLLM и локальных моделей.

Безопасность: базовые URL — константы (пользователь не задаёт адрес → нет SSRF); ключ передаётся только в заголовке и нигде не
логируется; редиректы отключены; тела ошибок провайдера очищаются от секретов и обрезаются.

Статус проверки форматов (на 2026-11-10): Anthropic и DeepSeek сверены с официальной документацией; формат OpenAI — по памяти
(страница документации вернула 403). Ни один адаптер не проверялся живым ключом: нужна проверка владельцем."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx

from app.core.security import redact

ProviderName = Literal["openai", "anthropic", "deepseek"]


@dataclass(frozen=True)
class ToolDef:
    name: str
    description: str
    parameters: dict[str, Any]


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any] | None  # None — модель вернула невалидный JSON


@dataclass
class Turn:
    text: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    input_tokens: int = 0
    output_tokens: int = 0


class ProviderError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code  # auth | rate_limit | timeout | unavailable | bad_request | bad_response
        self.message = message


def make_client(timeout: float) -> httpx.Client:
    """Подменяется в тестах (httpx.MockTransport). Редиректы запрещены."""
    return httpx.Client(timeout=timeout, follow_redirects=False)


def _error_from(resp: httpx.Response) -> ProviderError:
    detail = ""
    try:
        body = resp.json()
        err = body.get("error", body) if isinstance(body, dict) else body
        detail = err.get("message", "") if isinstance(err, dict) else str(err)
    except ValueError:
        detail = resp.text[:200]
    detail = redact(detail)[:300]
    if resp.status_code in (401, 403):
        return ProviderError("auth", "Провайдер отклонил ключ (неверный, отозван или нет прав).")
    if resp.status_code == 429:
        return ProviderError("rate_limit", "Превышен лимит запросов у провайдера. Повторите позже.")
    if resp.status_code >= 500:
        return ProviderError("unavailable", "Сервис провайдера временно недоступен.")
    return ProviderError("bad_request", f"Провайдер отклонил запрос ({resp.status_code}): {detail}")


def _post(url: str, headers: dict[str, str], payload: dict[str, Any], timeout: float) -> dict[str, Any]:
    try:
        with make_client(timeout) as c:
            resp = c.post(url, headers=headers, json=payload)
    except httpx.TimeoutException:
        raise ProviderError("timeout", "Провайдер не ответил за отведённое время.") from None
    except httpx.HTTPError:
        raise ProviderError("unavailable", "Не удалось связаться с провайдером.") from None
    if resp.status_code != 200:
        raise _error_from(resp)
    try:
        data = resp.json()
    except ValueError:
        raise ProviderError("bad_response", "Провайдер вернул некорректный ответ.") from None
    if not isinstance(data, dict):
        raise ProviderError("bad_response", "Провайдер вернул некорректный ответ.")
    return data


def _parse_args(raw: Any) -> dict[str, Any] | None:
    if isinstance(raw, dict):
        return raw
    try:
        v = json.loads(raw) if isinstance(raw, str) else None
    except ValueError:
        return None
    return v if isinstance(v, dict) else None


class OpenAICompatible:
    """OpenAI Chat Completions и совместимые (DeepSeek)."""

    def __init__(self, base_url: str, max_tokens_param: str) -> None:
        self.base_url, self.max_tokens_param = base_url, max_tokens_param

    def _headers(self, key: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    def chat(self, *, api_key: str, model: str, system: str, messages: list[dict[str, Any]], tools: list[ToolDef],
             max_tokens: int, timeout: float) -> Turn:
        out: list[dict[str, Any]] = [{"role": "system", "content": system}]
        for m in messages:
            if m["role"] == "assistant" and m.get("tool_calls"):
                out.append({"role": "assistant", "content": m.get("content") or None, "tool_calls": [
                    {"id": tc.id, "type": "function", "function": {"name": tc.name, "arguments": json.dumps(tc.arguments or {}, ensure_ascii=False)}}
                    for tc in m["tool_calls"]]})
            elif m["role"] == "tool":
                out.append({"role": "tool", "tool_call_id": m["tool_call_id"], "content": m["content"]})
            else:
                out.append({"role": m["role"], "content": m["content"]})
        payload: dict[str, Any] = {"model": model, "messages": out, self.max_tokens_param: max_tokens}
        if tools:
            payload["tools"] = [{"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.parameters}} for t in tools]
        data = _post(f"{self.base_url}/chat/completions", self._headers(api_key), payload, timeout)
        try:
            msg = data["choices"][0]["message"]
            calls = [ToolCall(id=str(tc["id"]), name=str(tc["function"]["name"]), arguments=_parse_args(tc["function"].get("arguments")))
                     for tc in (msg.get("tool_calls") or [])]
            usage = data.get("usage") or {}
            return Turn(text=(msg.get("content") or ""), tool_calls=calls,
                        input_tokens=int(usage.get("prompt_tokens", 0)), output_tokens=int(usage.get("completion_tokens", 0)))
        except (KeyError, IndexError, TypeError, ValueError):
            raise ProviderError("bad_response", "Провайдер вернул неожиданную структуру ответа.") from None

    def validate_key(self, api_key: str, timeout: float) -> str:
        """'valid' | 'invalid' | 'unavailable'. Список моделей не тарифицируется."""
        try:
            with make_client(timeout) as c:
                r = c.get(f"{self.base_url}/models", headers=self._headers(api_key))
        except httpx.HTTPError:
            return "unavailable"
        return "valid" if r.status_code == 200 else "invalid" if r.status_code in (401, 403) else "unavailable"


class AnthropicProvider:
    base_url = "https://api.anthropic.com/v1"
    version = "2026-10-21"  # значение из текущего примера документации (2026-11-10)

    def _headers(self, key: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {key}", "anthropic-version": self.version, "Content-Type": "application/json"}

    def chat(self, *, api_key: str, model: str, system: str, messages: list[dict[str, Any]], tools: list[ToolDef],
             max_tokens: int, timeout: float) -> Turn:
        out: list[dict[str, Any]] = []
        for m in messages:
            if m["role"] == "tool":
                block = {"type": "tool_result", "tool_use_id": m["tool_call_id"], "content": m["content"]}
                if out and out[-1]["role"] == "user" and isinstance(out[-1]["content"], list) and out[-1]["content"][-1].get("type") == "tool_result":
                    out[-1]["content"].append(block)  # результаты инструментов одного хода — в одном user-сообщении
                else:
                    out.append({"role": "user", "content": [block]})
            elif m["role"] == "assistant" and m.get("tool_calls"):
                blocks: list[dict[str, Any]] = ([{"type": "text", "text": m["content"]}] if m.get("content") else [])
                blocks += [{"type": "tool_use", "id": tc.id, "name": tc.name, "input": tc.arguments or {}} for tc in m["tool_calls"]]
                out.append({"role": "assistant", "content": blocks})
            else:
                out.append({"role": m["role"], "content": m["content"]})
        payload: dict[str, Any] = {"model": model, "max_tokens": max_tokens, "system": system, "messages": out}
        if tools:
            payload["tools"] = [{"name": t.name, "description": t.description, "input_schema": t.parameters} for t in tools]
        data = _post(f"{self.base_url}/messages", self._headers(api_key), payload, timeout)
        try:
            text, calls = "", []
            for b in data["content"]:
                if b.get("type") == "text":
                    text += b.get("text", "")
                elif b.get("type") == "tool_use":
                    calls.append(ToolCall(id=str(b["id"]), name=str(b["name"]), arguments=b["input"] if isinstance(b.get("input"), dict) else None))
            usage = data.get("usage") or {}
            return Turn(text=text, tool_calls=calls, input_tokens=int(usage.get("input_tokens", 0)), output_tokens=int(usage.get("output_tokens", 0)))
        except (KeyError, TypeError, ValueError):
            raise ProviderError("bad_response", "Провайдер вернул неожиданную структуру ответа.") from None

    def validate_key(self, api_key: str, timeout: float) -> str:
        try:
            with make_client(timeout) as c:
                r = c.get(f"{self.base_url}/models", headers=self._headers(api_key))
        except httpx.HTTPError:
            return "unavailable"
        return "valid" if r.status_code == 200 else "invalid" if r.status_code in (401, 403) else "unavailable"


PROVIDERS: dict[str, OpenAICompatible | AnthropicProvider] = {
    "openai": OpenAICompatible("https://api.openai.com/v1", "max_completion_tokens"),
    "deepseek": OpenAICompatible("https://api.deepseek.com", "max_tokens"),
    "anthropic": AnthropicProvider(),
}
