from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest

from app.db.models import AiKey
from app.modules.ai import chatgpt, chatgpt_auth, providers
from app.modules.ai.providers import ProviderError, ToolDef, Turn
from tests.conftest import login_full, make_server, make_user

API = "/api/v1"
KEYS = f"{API}/admin/ai-keys"


def connection(db, owner, *, expired=False) -> AiKey:
    session = chatgpt_auth.ChatGPTSession(
        client_id="oaiapp_test", subject="test-user", access_token="fake-access", refresh_token="fake-refresh",
        expires_at=int(time.time()) + (-5 if expired else 3600),
    )
    row = AiKey(organization_id=owner.org_id, created_by=owner.id, provider=chatgpt.PROVIDER, model="test-model",
                status="valid", masked="Test ChatGPT", key_enc=chatgpt.encode(session, owner.org_id))
    db.add(row)
    db.commit()
    return row


def test_admin_keys_and_subscription_are_scoped_to_the_owner(client, db, owner, monkeypatch):
    row = connection(db, owner)
    srv = make_server(db, owner.org_id)
    other = make_user(db, "second-owner@example.com", org_id=owner.org_id)
    operator = make_user(db, "operator@example.com", org_id=owner.org_id, role="operator")
    body = {"provider": "openai", "key": "test-api-key-1234", "model": "test-model", "skipValidation": True}

    headers = login_full(client, db, operator)
    assert client.get(KEYS).status_code == 403
    assert client.post(KEYS, headers=headers, json=body).status_code == 403
    assert client.get(f"{API}/ai-keys").json() == []

    headers = login_full(client, db, other)
    assert client.get(KEYS).json() == []
    assert client.delete(f"{KEYS}/{row.id}", headers=headers).status_code == 404
    r = client.post(f"{API}/conversations/messages", headers=headers, json={"serverId": str(srv.id), "text": "Проверка"})
    assert r.json()["code"] == "no_key"

    headers = login_full(client, db, owner)
    assert client.post(KEYS, headers=headers, json=body).status_code == 201
    result = client.get(KEYS)
    assert {item["provider"] for item in result.json()} == {"chatgpt", "openai"}
    assert "fake-access" not in result.text and "fake-refresh" not in result.text
    assert "test-api-key-1234" not in result.text

    def reply(self, *, api_key, **_):
        assert api_key == "fake-access"
        return Turn("Диагностика через подписку")

    monkeypatch.setattr(chatgpt.ChatGPTPlan, "chat", reply)
    r = client.post(f"{API}/conversations/messages", headers=headers, json={"serverId": str(srv.id), "text": "Проверка"})
    assert r.status_code == 200
    assert "Диагностика через подписку" in r.json()[1]["text"]

    monkeypatch.setattr(chatgpt_auth, "revoke", lambda *_: False)
    assert client.delete(f"{KEYS}/{row.id}", headers=headers).json() == {"ok": True, "revoked": False}
    assert [item["provider"] for item in client.get(KEYS).json()] == ["openai"]


def test_rotating_refresh_token_is_used_once_for_concurrent_requests(db, owner, monkeypatch):
    row = connection(db, owner, expired=True)
    calls: list[str] = []

    def refresh(session, _timeout):
        calls.append(session.refresh_token)
        return session.model_copy(update={
            "access_token": "renewed-access", "refresh_token": "renewed-refresh", "expires_at": int(time.time()) + 3600,
        })

    monkeypatch.setattr(chatgpt_auth, "refresh", refresh)
    key_id = row.id
    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(lambda _: chatgpt.access_token(key_id, owner.id, owner.org_id, 5), range(2)))
    assert results == ["renewed-access", "renewed-access"]
    assert calls == ["fake-refresh"]
    db.refresh(row)
    assert chatgpt.decode(row).refresh_token == "renewed-refresh"


def test_chatgpt_plan_streams_and_carries_tool_results(monkeypatch):
    calls: list[dict] = []
    function = {"type": "function_call", "name": "probe", "namespace": "servermind", "call_id": "call_1", "arguments": "{}"}
    message = {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Готово"}]}

    def respond(request: httpx.Request) -> httpx.Response:
        assert request.url == httpx.URL("https://api.openai.com/v1/responses")
        assert request.headers["authorization"] == "Bearer fake-access"
        calls.append(json.loads(request.content))
        event = {"type": "response.completed", "response": {"output": [function if len(calls) == 1 else message], "usage": {"input_tokens": 9}}}
        return httpx.Response(200, text=f"data: {json.dumps(event)}\n\n")

    monkeypatch.setattr(providers, "make_client", lambda timeout: httpx.Client(transport=httpx.MockTransport(respond), timeout=timeout))
    client = chatgpt.ChatGPTPlan()
    messages = [{"role": "user", "content": "Проверь сервер"}]
    args = {"api_key": "fake-access", "model": "test-model", "system": "instructions", "tools": [ToolDef("probe", "Проверка", {})],
            "max_tokens": 1024, "timeout": 5}
    turn = client.chat(messages=messages, **args)
    assert turn.tool_calls[0].id == "call_1"
    messages.extend([{"role": "assistant", "response_items": turn.response_items},
                     {"role": "tool", "tool_call_id": "call_1", "content": "OK"}])
    assert client.chat(messages=messages, **args).text == "Готово"
    assert calls[1]["input"][1:] == [function, {"type": "function_call_output", "call_id": "call_1", "output": "OK"}]
    assert calls[0]["tools"][0]["type"] == "namespace"
    assert calls[0]["stream"] is True and calls[0]["store"] is False
    assert "max_output_tokens" not in calls[0]


def test_chatgpt_plan_rejects_an_incomplete_stream(monkeypatch):
    transport = httpx.MockTransport(lambda _: httpx.Response(200, text='data: {"type":"response.created"}\n\n'))
    monkeypatch.setattr(providers, "make_client", lambda timeout: httpx.Client(transport=transport, timeout=timeout))
    with pytest.raises(ProviderError) as error:
        chatgpt.ChatGPTPlan().chat(api_key="fake-access", model="test-model", system="instructions", messages=[], tools=[], max_tokens=10, timeout=5)
    assert error.value.code == "bad_response"


def test_local_oauth_callback_uses_pkce_and_verifies_identity(monkeypatch):
    import base64
    import hashlib
    from types import SimpleNamespace
    from urllib.parse import parse_qs, urlencode, urlsplit

    import jwt
    from cryptography.hazmat.primitives.asymmetric import rsa

    from app.modules.ai import chatgpt_login

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    issued_id = "oaiapp_test"
    authorization: dict[str, str] = {}

    def browser(url):
        params = {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}
        authorization.update(params)
        callback = urlencode({"state": params["state"], "code": "test-code", "client_id": issued_id})
        return pool.submit(httpx.get, f'{params["redirect_uri"]}?{callback}', trust_env=False)

    def exchange(form, timeout):
        assert form["code"] == "test-code"
        assert form["client_id"] == issued_id
        assert form["redirect_uri"] == authorization["redirect_uri"]
        challenge = base64.urlsafe_b64encode(hashlib.sha256(form["code_verifier"].encode()).digest()).decode().rstrip("=")
        assert challenge == authorization["code_challenge"]
        claims = {"iss": chatgpt_auth.ISSUER, "aud": issued_id, "exp": int(time.time()) + 60,
                  "sub": "test-user", "nonce": authorization["nonce"]}
        return {"id_token": jwt.encode(claims, key, algorithm="RS256"), "scope": " ".join(chatgpt_auth.PLAN_SCOPES)}

    monkeypatch.setattr(chatgpt_login, "exchange", exchange)
    monkeypatch.setattr(jwt, "PyJWKClient", lambda *_args, **_kwargs: SimpleNamespace(
        get_signing_key_from_jwt=lambda _: SimpleNamespace(key=key.public_key()),
    ))
    with ThreadPoolExecutor(max_workers=1) as pool:
        monkeypatch.setattr(chatgpt_login.webbrowser, "open", browser)
        identity, _ = chatgpt_login.authorize("urn:uuid:example", {})
    assert identity == {"client_id": issued_id, "subject": "test-user"}
    assert authorization["code_challenge_method"] == "S256"
    assert authorization["client_id"] == "dynamic_agent_client"
