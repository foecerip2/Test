"""Подключение AI-моделей платформы из админ-панели (режим Credits): только администратор платформы, ключ шифруется и не утекает."""

from __future__ import annotations

import pytest
from sqlalchemy import text

from app.modules.ai.providers import ProviderError
from app.modules.billing import credits, ledger
from tests.conftest import login_full, make_server, make_user, set_env, text_turn

API = "/api/v1"
SECRET = "sk-ADMINPLATFORMKEY-0123456789"
BODY = {"provider": "openai", "model": "gpt-test", "key": SECRET, "priceIn": 10, "priceOut": 20, "priceListVersion": "2026-11", "skipValidation": True}


@pytest.fixture
def admin(db, monkeypatch):
    set_env(monkeypatch, platform_admin_emails='["admin@example.com"]')
    return make_user(db, "admin@example.com", role="owner")


@pytest.fixture
def ha(client, db, admin):
    return login_full(client, db, admin)


def add(client, ha, **over):
    return client.post(f"{API}/admin/models", headers=ha, json={**BODY, **over})


def test_only_platform_admin_sees_or_changes_models(client, db, owner, admin, ha):
    mid = add(client, ha).json()["id"]
    h_owner = login_full(client, db, owner)  # обычный владелец организации — не администратор платформы
    for method, path, body in [("get", "/admin/models", None), ("post", "/admin/models", BODY), ("post", f"/admin/models/{mid}/activate", None),
                               ("post", f"/admin/models/{mid}/check", None), ("delete", f"/admin/models/{mid}", None)]:
        r = getattr(client, method)(API + path, headers=h_owner, **({"json": body} if body else {}))
        assert r.status_code == 404, (method, path)
    client.cookies.clear()
    assert client.get(f"{API}/admin/models").status_code == 401
    assert db.execute(text("SELECT count(*) FROM platform_models")).scalar() == 1


def test_key_is_encrypted_masked_and_never_returned_or_logged(client, db, ha):
    r = add(client, ha)
    assert r.status_code == 201 and r.json()["masked"] == "sk-••••6789" and r.json()["active"] is True and r.json()["status"] == "unchecked"
    listing = client.get(f"{API}/admin/models", headers=ha)
    blob = bytes(db.execute(text("SELECT key_enc FROM platform_models")).scalar())
    assert b"ADMINPLATFORMKEY" not in blob and b"sk-" not in blob
    dump = " ".join(str(x) for q in ("SELECT * FROM audit_events",) for x in db.execute(text(q)).all())
    assert SECRET not in listing.text and SECRET not in r.text and SECRET not in dump and "ADMINPLATFORMKEY" not in dump
    assert db.execute(text("SELECT count(*) FROM audit_events WHERE action='platform_model.add'")).scalar() == 1


def test_first_model_is_active_and_activation_switches_exactly_one(client, db, ha):
    a = add(client, ha).json()
    b = add(client, ha, model="gpt-other").json()
    assert a["active"] is True and b["active"] is False
    r = client.post(f"{API}/admin/models/{b['id']}/activate", headers=ha)
    assert r.status_code == 200 and r.json()["active"] is True
    actives = [m["id"] for m in client.get(f"{API}/admin/models", headers=ha).json()["models"] if m["active"]]
    assert actives == [b["id"]]  # активна ровно одна
    # на уровне БД вторую активную создать нельзя
    with pytest.raises(Exception):  # noqa: B017, PT011 — IntegrityError драйвера
        db.execute(text("UPDATE platform_models SET active = true"))
        db.commit()
    db.rollback()


def test_validation_and_duplicates(client, db, ha):
    assert add(client, ha).status_code == 201
    assert add(client, ha).status_code == 409  # та же пара провайдер/модель
    for bad in ({"provider": "evil"}, {"key": "short"}, {"key": "has space " * 3}, {"model": "m; DROP"}, {"model": ""},
                {"priceIn": 0}, {"priceOut": -1}, {"priceIn": 10**10}):
        assert add(client, ha, **{"model": "x-model", **bad}).status_code == 422, bad
    assert db.execute(text("SELECT count(*) FROM platform_models")).scalar() == 1


def test_provider_check_on_add_and_explicit_check(client, db, ha, fake_provider):
    fake_provider.validate_result = "invalid"
    assert add(client, ha, skipValidation=False).status_code == 422
    fake_provider.validate_result = "unavailable"
    r = add(client, ha, skipValidation=False)
    assert r.status_code == 502 and "пропустить" in r.json()["message"]
    fake_provider.validate_result = "valid"
    m = add(client, ha, skipValidation=False)
    assert m.status_code == 201 and m.json()["status"] == "valid"
    fake_provider.validate_result = "invalid"
    chk = client.post(f"{API}/admin/models/{m.json()['id']}/check", headers=ha)
    assert chk.status_code == 200 and chk.json()["status"] == "invalid"
    assert client.post(f"{API}/admin/models/{m.json()['id']}/activate", headers=ha).status_code == 409  # с отклонённым ключом нельзя
    fake_provider.validate_result = "unavailable"
    assert client.post(f"{API}/admin/models/{m.json()['id']}/check", headers=ha).status_code == 502


def test_credits_chat_uses_admin_model_key_and_prices_not_env(client, db, owner, admin, ha, fake_provider, monkeypatch):
    for k in ("PLATFORM_AI_PROVIDER", "PLATFORM_AI_MODEL", "PLATFORM_AI_KEY", "PRICE_IN_PER_1K", "PRICE_OUT_PER_1K"):
        monkeypatch.delenv(k, raising=False)  # окружение пусто: всё идёт только из админ-панели
    add(client, ha, provider="anthropic", model="claude-test", priceIn=1000, priceOut=2000, priceListVersion="v-admin")
    ledger.issue(db, owner.org_id, 1_000_000, key="seed-0123456789", actor_id=None, note="seed")
    db.commit()
    srv = make_server(db, owner.org_id)
    h = login_full(client, db, owner)
    assert client.get(f"{API}/billing/balance").json()["creditsConfigured"] is True
    assert client.put(f"{API}/billing/mode", headers=h, json={"mode": "credits"}).status_code == 200
    fake_provider.script = [text_turn("ответ")]
    r = client.post(f"{API}/conversations/messages", headers=h, json={"serverId": str(srv.id), "text": "привет"})
    assert r.status_code == 200, r.text
    call = fake_provider.calls[0]
    assert call["api_key"] == SECRET and call["model"] == "claude-test"
    cap = next(u for u in client.get(f"{API}/billing/usage").json() if u["kind"] == "capture")
    # 100 вх. × 1000 + 20 вых. × 2000 = 140000 → /1000 = 140 кредитов
    assert cap["amount"] == -140 and "v-admin" in cap["note"] and cap["model"] == "claude-test"
    assert SECRET not in client.get(f"{API}/billing/usage").text


def test_without_any_model_credits_are_unavailable_then_env_fallback_works(client, db, owner, monkeypatch):
    for k in ("PLATFORM_AI_PROVIDER", "PLATFORM_AI_MODEL", "PLATFORM_AI_KEY", "PRICE_IN_PER_1K", "PRICE_OUT_PER_1K"):
        monkeypatch.delenv(k, raising=False)
    h = login_full(client, db, owner)
    r = client.put(f"{API}/billing/mode", headers=h, json={"mode": "credits"})
    assert r.status_code == 409 and "администратор платформы не подключил модель" in r.json()["message"]
    set_env(monkeypatch, platform_ai_provider="openai", platform_ai_model="m", platform_ai_key="env-key-0123456789", price_in_per_1k="5", price_out_per_1k="5")
    assert client.put(f"{API}/billing/mode", headers=h, json={"mode": "credits"}).status_code == 200


def test_deleting_the_active_model_disables_credits_mode(client, db, owner, admin, ha, fake_provider, monkeypatch):
    for k in ("PLATFORM_AI_PROVIDER", "PLATFORM_AI_MODEL", "PLATFORM_AI_KEY", "PRICE_IN_PER_1K", "PRICE_OUT_PER_1K"):
        monkeypatch.delenv(k, raising=False)
    mid = add(client, ha).json()["id"]
    ledger.issue(db, owner.org_id, 100_000, key="seed-1234567890", actor_id=None, note="seed")
    db.commit()
    srv = make_server(db, owner.org_id)
    h = login_full(client, db, owner)
    client.put(f"{API}/billing/mode", headers=h, json={"mode": "credits"})
    ha2 = login_full(client, db, admin)
    assert client.delete(f"{API}/admin/models/{mid}", headers=ha2).json() == {"ok": True}
    h = login_full(client, db, owner)
    fake_provider.script = [text_turn("не должно")]
    r = client.post(f"{API}/conversations/messages", headers=h, json={"serverId": str(srv.id), "text": "привет"})
    assert r.status_code == 409 and r.json()["code"] == "mode_unavailable" and fake_provider.calls == []
    assert client.get(f"{API}/billing/balance").json()["creditsConfigured"] is False


def test_key_blob_cannot_be_moved_to_another_row(db, client, ha):
    a = add(client, ha).json()
    b = add(client, ha, model="gpt-other", key="sk-ANOTHERKEY-0123456789").json()
    db.execute(text("UPDATE platform_models SET key_enc = (SELECT key_enc FROM platform_models WHERE id = :a) WHERE id = :b"), {"a": a["id"], "b": b["id"]})
    db.commit()
    from app.core.config import get_settings  # noqa: PLC0415
    client.post(f"{API}/admin/models/{b['id']}/activate", headers=ha)
    assert credits.resolve_platform_ai(db, get_settings()) is None  # привязка к id строки: чужой блоб не расшифровывается


def test_chat_failure_with_admin_model_does_not_charge(client, db, owner, admin, ha, fake_provider, monkeypatch):
    for k in ("PLATFORM_AI_PROVIDER", "PLATFORM_AI_MODEL", "PLATFORM_AI_KEY", "PRICE_IN_PER_1K", "PRICE_OUT_PER_1K"):
        monkeypatch.delenv(k, raising=False)
    add(client, ha)
    ledger.issue(db, owner.org_id, 100_000, key="seed-abcdefghij", actor_id=None, note="seed")
    db.commit()
    srv = make_server(db, owner.org_id)
    h = login_full(client, db, owner)
    client.put(f"{API}/billing/mode", headers=h, json={"mode": "credits"})
    fake_provider.script = [ProviderError("auth", "bad key")]
    r = client.post(f"{API}/conversations/messages", headers=h, json={"serverId": str(srv.id), "text": "привет"})
    assert r.status_code == 502 and r.json()["code"] == "ai_unavailable"
    assert client.get(f"{API}/billing/balance").json()["available"] == 100_000
