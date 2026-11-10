"""Биллинг, режим Credits и админка закрытой беты (ADR 0005)."""

from __future__ import annotations

import pytest
from sqlalchemy import text

from app.modules.ai.providers import ProviderError
from app.modules.billing import ledger
from tests.conftest import login_full, make_server, make_user, set_env, text_turn, tool_turn

API = "/api/v1"
PLATFORM_KEY = "plat-SECRETKEY-0123456789"
CFG = {"platform_ai_provider": "openai", "platform_ai_model": "plat-model", "platform_ai_key": PLATFORM_KEY,
       "price_in_per_1k": "10", "price_out_per_1k": "20", "price_list_version": "2026-11", "platform_admin_emails": '["admin@example.com"]'}


@pytest.fixture
def h(client, db, owner):
    return login_full(client, db, owner)


@pytest.fixture
def cfg(monkeypatch):
    set_env(monkeypatch, **CFG)


@pytest.fixture
def admin(client, db):
    a = make_user(db, "admin@example.com", role="owner")
    return a


def give(db, org, amount):
    ledger.issue(db, org, amount, key=f"seed-{amount}-{id(db)}", actor_id=None, note="seed")
    db.commit()


def credits_mode(client, h):
    r = client.put(f"{API}/billing/mode", headers=h, json={"mode": "credits"})
    assert r.status_code == 200, r.text


def ask(client, h, srv, fake_provider, script):
    fake_provider.script = script
    return client.post(f"{API}/conversations/messages", headers=h, json={"serverId": str(srv.id), "text": "что с сервером?"})


# ───────── баланс, режим, права ─────────
def test_balance_is_zero_and_honest_by_default(client, h):
    b = client.get(f"{API}/billing/balance").json()
    assert (b["available"], b["reserved"], b["dailyCap"], b["monthlyCap"], b["mode"], b["creditsConfigured"]) == (0, 0, None, None, "byok", False)
    assert client.get(f"{API}/billing/usage").json() == []


def test_credits_mode_needs_server_configuration_and_owner(client, db, owner, h, cfg, monkeypatch):
    set_env(monkeypatch, platform_ai_key="")  # ключ платформы не задан
    r = client.put(f"{API}/billing/mode", headers=h, json={"mode": "credits"})
    assert r.status_code == 409 and r.json()["code"] == "mode_unavailable" and "не настроен" in r.json()["message"]
    set_env(monkeypatch, platform_ai_key=PLATFORM_KEY)
    credits_mode(client, h)
    assert client.get(f"{API}/billing/mode").json() == {"mode": "credits"}
    assert client.get(f"{API}/billing/balance").json()["creditsConfigured"] is True
    assert db.execute(text("SELECT count(*) FROM audit_events WHERE action='billing.mode_changed'")).scalar() == 1
    op = make_user(db, "op@example.com", role="operator", org_id=owner.org_id)
    hop = login_full(client, db, op)
    assert client.put(f"{API}/billing/mode", headers=hop, json={"mode": "byok"}).status_code == 403  # только владелец
    h_owner = login_full(client, db, owner)  # cookie владельца затёрт входом оператора
    assert client.put(f"{API}/billing/mode", headers=h_owner, json={"mode": "byok"}).json() == {"mode": "byok"}


# ───────── администратор: выдача кредитов ─────────
def issue(client, ha, email, amount=500, key="idem-0123456789", reason="бета-тест"):
    return client.post(f"{API}/admin/credits/issue", headers=ha, json={"email": email, "amount": amount, "reason": reason, "idempotencyKey": key})


def test_only_platform_admin_can_issue_and_it_is_audited_and_idempotent(client, db, owner, admin, h, cfg):
    # обычный владелец: эндпоинта «нет»
    assert issue(client, h, owner.email).status_code == 404
    assert client.get(f"{API}/admin/audit", headers=h).status_code == 404
    ha = login_full(client, db, admin)
    r = issue(client, ha, owner.email, 500)
    assert r.status_code == 200 and r.json()["created"] is True and r.json()["available"] == 500
    again = issue(client, ha, owner.email, 500)  # повтор (ретрай/двойной клик) с тем же ключом
    assert again.json()["created"] is False and again.json()["available"] == 500
    assert db.execute(text("SELECT count(*) FROM audit_events WHERE action='credits.issued'")).scalar() == 1
    assert issue(client, ha, owner.email, 900).status_code == 409  # тот же ключ, другая сумма
    # владелец видит начисление в своём ledger
    client.cookies.clear()
    h2 = login_full(client, db, owner)
    usage = client.get(f"{API}/billing/usage", headers=h2).json()
    assert [(u["kind"], u["amount"]) for u in usage] == [("credit", 500)] and usage[0]["note"].startswith("Тестовые кредиты")
    assert client.get(f"{API}/billing/balance").json()["available"] == 500


def test_admin_input_validation(client, db, owner, admin, cfg):
    ha = login_full(client, db, admin)
    assert issue(client, ha, "nobody@example.com").status_code == 404
    assert issue(client, ha, owner.email, amount=0).status_code == 422
    assert issue(client, ha, owner.email, amount=-5).status_code == 422
    assert issue(client, ha, owner.email, key="short").status_code == 422
    assert issue(client, ha, owner.email, reason="ab").status_code == 422
    assert client.post(f"{API}/admin/credits/issue", headers=ha, json={"email": owner.email, "amount": 5, "reason": "ok ok"}).status_code == 422  # без ключа
    assert db.execute(text("SELECT count(*) FROM ledger_entries")).scalar() == 0


def test_admin_audit_feed_shows_events_without_secrets(client, db, owner, admin, cfg):
    ha = login_full(client, db, admin)
    issue(client, ha, owner.email)
    feed = client.get(f"{API}/admin/audit", headers=ha).json()
    assert any(e["action"] == "credits.issued" and e["actor"] == "admin@example.com" for e in feed)
    assert PLATFORM_KEY not in str(feed)


# ───────── чат в режиме Credits ─────────
@pytest.fixture
def srv(db, owner):
    return make_server(db, owner.org_id)


def test_chat_without_credits_is_refused_before_the_model_is_called(client, db, owner, h, cfg, srv, fake_provider):
    credits_mode(client, h)
    r = ask(client, h, srv, fake_provider, [text_turn("не должно вызываться")])
    assert r.status_code == 402 and r.json()["code"] == "insufficient_credits"
    assert fake_provider.calls == []  # провайдер НЕ вызывался: платформа не платит за запросы без кредитов
    assert db.execute(text("SELECT count(*) FROM messages")).scalar() == 0
    assert db.execute(text("SELECT count(*) FROM ledger_entries")).scalar() == 0


def test_chat_charges_actual_tokens_once_and_returns_the_rest(client, db, owner, h, cfg, srv, fake_provider):
    give(db, owner.org_id, 100_000)
    credits_mode(client, h)
    r = ask(client, h, srv, fake_provider, [text_turn("всё в порядке")])
    assert r.status_code == 200, r.text
    # text_turn: 100 входных + 20 выходных токенов; цена 10/20 за 1000 → ceil((1000 + 400)/1000) = 2
    b = client.get(f"{API}/billing/balance").json()
    assert (b["available"], b["reserved"]) == (99_998, 0)
    usage = client.get(f"{API}/billing/usage").json()
    cap = next(u for u in usage if u["kind"] == "capture")
    assert cap["amount"] == -2 and cap["model"] == "plat-model" and (cap["tokensIn"], cap["tokensOut"]) == (100, 20) and "2026-11" in cap["note"]
    assert {u["kind"] for u in usage} == {"credit", "reserve", "capture", "release"}
    assert ledger.verify(db, owner.org_id) == []
    assert fake_provider.calls[0]["api_key"] == PLATFORM_KEY and fake_provider.calls[0]["model"] == "plat-model"


def test_tokens_of_all_iterations_are_summed(client, db, owner, h, cfg, srv, fake_provider):
    give(db, owner.org_id, 100_000)
    credits_mode(client, h)
    r = ask(client, h, srv, fake_provider, [tool_turn(("server.facts", {})), text_turn("готово")])
    assert r.status_code == 200
    cap = next(u for u in client.get(f"{API}/billing/usage").json() if u["kind"] == "capture")
    assert (cap["tokensIn"], cap["tokensOut"]) == (200, 40)  # две обращения к модели по 100/20
    assert ledger.verify(db, owner.org_id) == []


@pytest.mark.parametrize("err,status", [("timeout", 504), ("unavailable", 502), ("rate_limit", 429)])
def test_provider_failure_releases_credits_and_leaves_no_message(client, db, owner, h, cfg, srv, fake_provider, err, status):
    give(db, owner.org_id, 100_000)
    credits_mode(client, h)
    r = ask(client, h, srv, fake_provider, [ProviderError(err, "сбой")])
    assert r.status_code == status
    b = client.get(f"{API}/billing/balance").json()
    assert (b["available"], b["reserved"]) == (100_000, 0)  # за неудавшийся запрос не списано ничего
    assert db.execute(text("SELECT count(*) FROM messages")).scalar() == 0
    assert db.execute(text("SELECT count(*) FROM ledger_entries WHERE kind='capture'")).scalar() == 0
    assert ledger.verify(db, owner.org_id) == []
    # повтор после сбоя проходит и списывает один раз
    ok = ask(client, h, srv, fake_provider, [text_turn("теперь ок")])
    assert ok.status_code == 200 and client.get(f"{API}/billing/balance").json()["available"] == 99_998


def test_platform_key_failure_is_not_blamed_on_the_user_and_not_charged(client, db, owner, h, cfg, srv, fake_provider):
    give(db, owner.org_id, 100_000)
    credits_mode(client, h)
    r = ask(client, h, srv, fake_provider, [ProviderError("auth", "invalid key")])
    assert r.status_code == 502 and r.json()["code"] == "ai_unavailable" and "Кредиты не списаны" in r.json()["message"]
    assert client.get(f"{API}/billing/balance").json()["available"] == 100_000


def test_spend_caps_block_requests_without_calling_the_model(client, db, owner, h, cfg, srv, fake_provider, monkeypatch):
    give(db, owner.org_id, 100_000)
    credits_mode(client, h)
    set_env(monkeypatch, credits_daily_cap="1")
    r = ask(client, h, srv, fake_provider, [text_turn("нет")])
    assert r.status_code == 429 and r.json()["code"] == "credits_cap_daily" and fake_provider.calls == []
    monkeypatch.delenv("CREDITS_DAILY_CAP")  # лимит снят (None), остался только месячный
    set_env(monkeypatch, credits_monthly_cap="1")
    r2 = ask(client, h, srv, fake_provider, [text_turn("нет")])
    assert r2.status_code == 429 and r2.json()["code"] == "credits_cap_monthly" and fake_provider.calls == []
    assert client.get(f"{API}/billing/balance").json()["monthlyCap"] == 1


def test_unconfigured_platform_blocks_credit_chat_cleanly(client, db, owner, h, cfg, srv, fake_provider, monkeypatch):
    credits_mode(client, h)
    set_env(monkeypatch, platform_ai_key="")  # конфигурацию убрали уже после включения режима
    r = ask(client, h, srv, fake_provider, [text_turn("нет")])
    assert r.status_code == 409 and r.json()["code"] == "mode_unavailable" and fake_provider.calls == []


def test_byok_mode_never_touches_the_ledger(client, db, owner, h, cfg, srv, fake_provider):
    from tests.conftest import add_ai_key  # noqa: PLC0415
    add_ai_key(client, h)
    r = ask(client, h, srv, fake_provider, [text_turn("свой ключ")])
    assert r.status_code == 200
    assert db.execute(text("SELECT count(*) FROM ledger_entries")).scalar() == 0
    assert fake_provider.calls[0]["api_key"] != PLATFORM_KEY


def test_platform_key_never_leaks_into_responses_logs_or_db(client, db, owner, admin, h, cfg, srv, fake_provider):
    give(db, owner.org_id, 100_000)
    credits_mode(client, h)
    ask(client, h, srv, fake_provider, [text_turn("ok")])
    bodies = [client.get(f"{API}{p}").text for p in ("/billing/balance", "/billing/usage", "/billing/mode", "/me")]
    ha = login_full(client, db, admin)
    bodies.append(client.get(f"{API}/admin/audit", headers=ha).text)
    dump = " ".join(str(r) for q in ("SELECT * FROM audit_events", "SELECT * FROM ledger_entries", "SELECT * FROM messages", "SELECT * FROM ai_usage")
                    for r in db.execute(text(q)).all())
    assert PLATFORM_KEY not in " ".join(bodies) and PLATFORM_KEY not in dump


def test_ledgers_of_different_organizations_are_isolated(client, db, owner, h, cfg):
    give(db, owner.org_id, 777)
    other = make_user(db, "mallory@example.com", role="owner")
    h2 = login_full(client, db, other)
    assert client.get(f"{API}/billing/usage", headers=h2).json() == []
    assert client.get(f"{API}/billing/balance", headers=h2).json()["available"] == 0


def test_requires_login(client):
    for p in ("/billing/balance", "/billing/usage"):
        assert client.get(f"{API}{p}").status_code == 401
    assert client.get(f"{API}/admin/audit").status_code == 401


def test_stale_reservation_sweeper_frees_credits_after_a_crash(client, db, owner, h, cfg, monkeypatch):
    import datetime as dt  # noqa: PLC0415

    from app.modules.executor import worker  # noqa: PLC0415
    give(db, owner.org_id, 1000)
    res, _ = ledger.reserve(db, owner.org_id, 400, key="crash-0123456789")  # «процесс упал» до списания
    db.commit()
    db.execute(text("UPDATE ledger_reservations SET created_at = :t"), {"t": dt.datetime.now(dt.UTC) - dt.timedelta(minutes=30)})
    db.commit()
    assert client.get(f"{API}/billing/balance").json()["reserved"] == 400
    monkeypatch.setattr(worker, "_last_sweep", 0.0)
    worker.sweep_reservations()
    b = client.get(f"{API}/billing/balance").json()
    assert (b["available"], b["reserved"]) == (1000, 0)
    assert ledger.verify(db, owner.org_id) == []
