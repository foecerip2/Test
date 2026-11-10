import json

import httpx
import pytest

from app.modules.ai import providers as p
from app.modules.ai.providers import PROVIDERS, ProviderError, ToolCall, ToolDef

SECRET = "sk-LIVEKEY-abcdefghijklmnopqrstuv"
TOOLS = [ToolDef("server.facts", "facts", {"type": "object", "properties": {}})]
MSGS = [{"role": "user", "content": "привет"}]


@pytest.fixture
def mock_http(monkeypatch):
    seen: list[httpx.Request] = []

    def install(handler):
        def wrapped(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return handler(request)

        monkeypatch.setattr(p, "make_client", lambda timeout: httpx.Client(transport=httpx.MockTransport(wrapped), timeout=timeout))
        return seen

    return install


def call(name, **over):
    kw = dict(api_key=SECRET, model="m", system="sys", messages=MSGS, tools=TOOLS, max_tokens=100, timeout=5)
    kw.update(over)
    return PROVIDERS[name].chat(**kw)


def test_openai_request_and_response_shape(mock_http):
    seen = mock_http(lambda r: httpx.Response(200, json={
        "choices": [{"message": {"content": None, "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "server.facts", "arguments": "{}"}}]}}],
        "usage": {"prompt_tokens": 11, "completion_tokens": 5}}))
    t = call("openai")
    assert [(c.id, c.name, c.arguments) for c in t.tool_calls] == [("c1", "server.facts", {})] and (t.input_tokens, t.output_tokens) == (11, 5)
    req = seen[0]
    body = json.loads(req.content)
    assert str(req.url) == "https://api.openai.com/v1/chat/completions" and req.headers["authorization"] == f"Bearer {SECRET}"
    assert body["max_completion_tokens"] == 100 and "max_tokens" not in body
    assert body["messages"][0] == {"role": "system", "content": "sys"} and body["tools"][0]["function"]["name"] == "server.facts"
    assert SECRET not in req.content.decode()  # ключ только в заголовке, не в теле


def test_deepseek_uses_own_base_url_and_max_tokens(mock_http):
    seen = mock_http(lambda r: httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}], "usage": {}}))
    assert call("deepseek").text == "ok"
    assert str(seen[0].url) == "https://api.deepseek.com/chat/completions" and json.loads(seen[0].content)["max_tokens"] == 100


def test_anthropic_request_and_tool_result_roundtrip(mock_http):
    seen = mock_http(lambda r: httpx.Response(200, json={
        "content": [{"type": "text", "text": "смотрю"}, {"type": "tool_use", "id": "tu1", "name": "server.facts", "input": {}}],
        "usage": {"input_tokens": 7, "output_tokens": 3}, "stop_reason": "tool_use"}))
    t = call("anthropic")
    assert t.text == "смотрю" and t.tool_calls[0].name == "server.facts" and (t.input_tokens, t.output_tokens) == (7, 3)
    assert str(seen[0].url) == "https://api.anthropic.com/v1/messages" and seen[0].headers["anthropic-version"]
    # второй ход: результаты двух инструментов склеиваются в одно user-сообщение
    hist = [*MSGS, {"role": "assistant", "content": "", "tool_calls": [ToolCall("a", "server.facts", {}), ToolCall("b", "service.status", {})]},
            {"role": "tool", "tool_call_id": "a", "name": "server.facts", "content": "r1"},
            {"role": "tool", "tool_call_id": "b", "name": "service.status", "content": "r2"}]
    call("anthropic", messages=hist)
    msgs = json.loads(seen[1].content)["messages"]
    assert msgs[-1]["role"] == "user" and [b["tool_use_id"] for b in msgs[-1]["content"]] == ["a", "b"]
    assert msgs[1]["content"][0]["type"] == "tool_use"
    assert "tools" in json.loads(seen[1].content) and json.loads(seen[1].content)["tools"][0]["input_schema"]["type"] == "object"


@pytest.mark.parametrize("status,code", [(401, "auth"), (403, "auth"), (429, "rate_limit"), (500, "unavailable"), (503, "unavailable"), (400, "bad_request")])
def test_http_errors_are_classified_and_never_echo_the_key(mock_http, status, code):
    mock_http(lambda r: httpx.Response(status, json={"error": {"message": f"bad key {SECRET} password=hunter2"}}))
    with pytest.raises(ProviderError) as e:
        call("openai")
    assert e.value.code == code
    assert SECRET not in e.value.message and "hunter2" not in e.value.message


def test_timeout_network_and_garbage_responses(mock_http):
    def boom(r):
        raise httpx.ReadTimeout("t")

    mock_http(boom)
    with pytest.raises(ProviderError) as e:
        call("anthropic")
    assert e.value.code == "timeout"
    mock_http(lambda r: httpx.Response(200, text="not json"))
    with pytest.raises(ProviderError) as e2:
        call("openai")
    assert e2.value.code == "bad_response"
    mock_http(lambda r: httpx.Response(200, json={"choices": []}))
    with pytest.raises(ProviderError) as e3:
        call("openai")
    assert e3.value.code == "bad_response"


def test_invalid_tool_arguments_become_none_not_executed(mock_http):
    mock_http(lambda r: httpx.Response(200, json={"choices": [{"message": {"content": "", "tool_calls": [
        {"id": "c", "type": "function", "function": {"name": "propose_plan", "arguments": "{not json"}}]}}]}))
    assert call("openai").tool_calls[0].arguments is None


@pytest.mark.parametrize("name", ["openai", "deepseek", "anthropic"])
def test_validate_key_uses_free_models_endpoint(mock_http, name):
    seen = mock_http(lambda r: httpx.Response(200, json={"data": []}))
    assert PROVIDERS[name].validate_key(SECRET, 5) == "valid"
    assert seen[0].method == "GET" and seen[0].url.path.endswith("/models")
    mock_http(lambda r: httpx.Response(401, json={}))
    assert PROVIDERS[name].validate_key(SECRET, 5) == "invalid"
    mock_http(lambda r: httpx.Response(502, json={}))
    assert PROVIDERS[name].validate_key(SECRET, 5) == "unavailable"


def test_redirects_are_not_followed():
    c = p.make_client(5)
    assert c.follow_redirects is False
