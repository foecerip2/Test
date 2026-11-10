"""OAuth для самостоятельного размещения ServerMind (Sign in with ChatGPT)."""

from __future__ import annotations

import time
from typing import Any

import httpx
from pydantic import BaseModel, Field, ValidationError

from app.modules.ai.providers import ProviderError, make_client

ISSUER = "https://auth.openai.com"
AUTHORIZE = f"{ISSUER}/api/accounts/authorize"
TOKEN = f"{ISSUER}/api/accounts/oauth/token"
RESOURCE = "https://api.openai.com/v1"
PLAN_SCOPES = {"chatgpt.tokens.use.direct", "resource.invoke", "offline_access"}


class ChatGPTSession(BaseModel):
    client_id: str = Field(pattern=r"^oaiapp_[A-Za-z0-9_-]{1,128}$")
    subject: str = Field(min_length=1, max_length=512)
    email: str = Field(default="", max_length=254)
    access_token: str = Field(min_length=1, max_length=16000, repr=False)
    refresh_token: str = Field(min_length=1, max_length=16000, repr=False)
    id_token: str = Field(default="", max_length=16000, repr=False)
    expires_at: int = Field(gt=0)


def exchange(data: dict[str, str], timeout: float) -> dict[str, Any]:
    try:
        with make_client(timeout) as client:
            response = client.post(TOKEN, data={**data, "resource": RESOURCE})
            if response.status_code == 429:
                raise ProviderError("rate_limit", "OpenAI ограничил обновление сессии. Повторите позже.")
            if response.status_code >= 500:
                raise ProviderError("unavailable", "Авторизация OpenAI временно недоступна.")
            if not response.is_success:
                raise ProviderError("auth", "OpenAI отклонил авторизацию. Войдите в ChatGPT заново.")
            result = response.json()
            if isinstance(result, dict):
                return result
    except httpx.TimeoutException:
        raise ProviderError("timeout", "OpenAI не ответил на запрос авторизации.") from None
    except httpx.HTTPError:
        raise ProviderError("unavailable", "Не удалось связаться с OpenAI.") from None
    except ValueError:
        pass
    raise ProviderError("bad_response", "Некорректный ответ авторизации OpenAI.")


def updated_session(identity: dict[str, str], data: dict[str, Any]) -> ChatGPTSession:
    try:
        if data["token_type"].lower() != "bearer":
            raise ValueError
        if "scope" in data and not PLAN_SCOPES <= set(data["scope"].split()):
            raise ProviderError("auth", "Подписка ChatGPT не предоставила доступ к запросам модели.")
        return ChatGPTSession(
            **identity, access_token=data["access_token"], refresh_token=data["refresh_token"],
            id_token=data.get("id_token") or "", expires_at=int(time.time()) + int(data["expires_in"]),
        )
    except (KeyError, ValueError, TypeError, AttributeError, ValidationError):
        raise ProviderError("bad_response", "Ответ OpenAI не содержит действительных данных сессии.") from None


def refresh(session: ChatGPTSession, timeout: float) -> ChatGPTSession:
    data = exchange({"grant_type": "refresh_token", "client_id": session.client_id, "refresh_token": session.refresh_token}, timeout)
    return updated_session(
        {"client_id": session.client_id, "subject": session.subject, "email": session.email},
        {**data, "id_token": data.get("id_token") or session.id_token},
    )


def listed_models(access_token: str, timeout: float) -> list[str]:
    try:
        with make_client(timeout) as client:
            response = client.get(f"{RESOURCE}/models", headers={"Authorization": f"Bearer {access_token}"})
        if response.status_code in (401, 403):
            raise ProviderError("auth", "OpenAI отклонил доступ к подписке. Проверьте аккаунт и выбранное рабочее пространство.")
        response.raise_for_status()
        return [item["slug"] for item in response.json()["models"] if item.get("visibility") == "list"]
    except (httpx.HTTPError, ValueError, KeyError, TypeError, AttributeError):
        raise ProviderError("unavailable", "Не удалось получить список моделей подписки ChatGPT.") from None


def revoke(session: ChatGPTSession, timeout: float) -> bool:
    try:
        with make_client(timeout) as client:
            discovery = client.get(f"{ISSUER}/.well-known/openid-configuration")
            discovery.raise_for_status()
            endpoint = httpx.URL(discovery.json()["revocation_endpoint"])
            if (endpoint.scheme, endpoint.host, endpoint.port) != ("https", "auth.openai.com", None) or endpoint.userinfo:
                return False
            response = client.post(endpoint, data={
                "client_id": session.client_id, "token": session.refresh_token, "token_type_hint": "refresh_token",
            })
            return response.status_code == 200
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        return False
