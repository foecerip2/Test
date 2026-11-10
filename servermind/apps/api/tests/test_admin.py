"""Админ-панель платформы: флаги, kill switch, приглашения/регистрация, пользователи. Только администратор платформы."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.main import create_app
from app.modules.billing import ledger
from tests.conftest import PASSWORD, add_ai_key, login_full, make_server, make_user, set_env, text_turn

API = "/api/v1"
NEW_PW = "brand-new-password-123"


@pytest.fixture
def admin(db, monkeypatch):
    set_env(monkeypatch, platform_admin_emails='["admin@example.com"]')
    return make_user(db, "admin@example.com", role="owner")


@pytest.fixture
def ha(client, db, admin):
    return login_full(client, db, admin)


def new_invite(client, ha):
    r = client.post(f"{API}/admin/invites", headers=ha)
    assert r.status_code == 201, r.text
    return r.json()["code"]


def register(client, code, email="newbie@example.com", password=NEW_PW, **extra):
    return client.post(f"{API}/auth/register", json={"email": email, "password": password, "inviteCode": code, **extra})


# ───────── доступ ─────────
def test_every_admin_endpoint_is_hidden_from_regular_users(client, db, owner, admin):
    h = login_full(client, db, owner)
    checks = [("get", "/admin/flags", None), ("put", "/admin/flags/ai_chat", {"enabled": False}), ("get", "/admin/kill-switch", None),
              ("put", "/admin/kill-switch", {"executionEnabled": False}), ("get", "/admin/invites", None), ("post", "/admin/invites", None),
              ("get", "/admin/users", None), ("post", f"/admin/users/{owner.id}/active", {"active": False})]
    for method, path, body in checks:
        r = getattr(client, method)(API + path, headers=h, **({"json": body} if body is not None else {}))
        assert r.status_code == 404, (method, path)
    client.cookies.clear()
    assert client.get(f"{API}/admin/flags").status_code == 401


# ───────── флаги ─────────
def test_flags_have_defaults_toggle_and_are_audited(client, db, ha):
    flags = client.get(f"{API}/admin/flags", headers=ha).json()
    assert {f["key"] for f in flags} == {"ai_chat", "credits_mode", "registration"} and all(f["enabled"] for f in flags)
    assert all(f["label"] and f["description"] for f in flags)
    r = client.put(f"{API}/admin/flags/ai_chat", headers=ha, json={"enabled": False})
    assert r.status_code == 200 and next(f for f in r.json() if f["key"] == "ai_chat")["enabled"] is False
    assert client.put(f"{API}/admin/flags/unknown", headers=ha, json={"enabled": True}).status_code == 404
    assert client.put(f"{API}/admin/flags/ai_chat", headers=ha, json={"enabled": "yes", "extra": 1}).status_code == 422
    assert db.execute(text("SELECT count(*) FROM audit_events WHERE action='flag.set'")).scalar() == 1


def test_ai_chat_flag_stops_the_chat_for_everyone(client, db, owner, admin, ha, fake_provider):
    srv = make_server(db, owner.org_id)
    client.put(f"{API}/admin/flags/ai_chat", headers=ha, json={"enabled": False})
    h = login_full(client, db, owner)
    add_ai_key(client, h)
    fake_provider.script = [text_turn("не должно")]
    r = client.post(f"{API}/conversations/messages", headers=h, json={"serverId": str(srv.id), "text": "привет"})
    assert r.status_code == 503 and r.json()["code"] == "feature_disabled" and fake_provider.calls == []
    ha2 = login_full(client, db, admin)
    client.put(f"{API}/admin/flags/ai_chat", headers=ha2, json={"enabled": True})
    h = login_full(client, db, owner)
    assert client.post(f"{API}/conversations/messages", headers=h, json={"serverId": str(srv.id), "text": "привет"}).status_code == 200


def test_credits_flag_blocks_switch_and_credit_chat(client, db, owner, admin, ha, fake_provider, monkeypatch):
    set_env(monkeypatch, platform_ai_provider="openai", platform_ai_model="m", platform_ai_key="plat-key-0123456789", price_in_per_1k="10", price_out_per_1k="20")
    srv = make_server(db, owner.org_id)
    ledger.issue(db, owner.org_id, 100_000, key="seed-0123456789", actor_id=None, note="seed")
    db.commit()
    h = login_full(client, db, owner)
    assert client.put(f"{API}/billing/mode", headers=h, json={"mode": "credits"}).status_code == 200
    ha2 = login_full(client, db, admin)
    client.put(f"{API}/admin/flags/credits_mode", headers=ha2, json={"enabled": False})
    h = login_full(client, db, owner)
    fake_provider.script = [text_turn("нет")]
    r = client.post(f"{API}/conversations/messages", headers=h, json={"serverId": str(srv.id), "text": "привет"})
    assert r.status_code == 409 and r.json()["code"] == "feature_disabled" and fake_provider.calls == []
    assert client.put(f"{API}/billing/mode", headers=h, json={"mode": "byok"}).status_code == 200
    assert client.put(f"{API}/billing/mode", headers=h, json={"mode": "credits"}).json()["code"] == "feature_disabled"


# ───────── kill switch ─────────
def test_kill_switch_cannot_enable_what_config_forbids(client, ha):
    k = client.get(f"{API}/admin/kill-switch", headers=ha).json()
    assert k == {"executionEnabled": False, "configAllows": False, "engaged": False}
    r = client.put(f"{API}/admin/kill-switch", headers=ha, json={"executionEnabled": True})
    assert r.status_code == 409 and r.json()["code"] == "execution_disabled_by_config"


def test_kill_switch_stops_new_jobs_and_can_resume(client, db, owner, admin, ha, fake_provider, monkeypatch):
    set_env(monkeypatch, execution_enabled="true")
    assert client.get(f"{API}/admin/kill-switch", headers=ha).json()["executionEnabled"] is True
    srv = make_server(db, owner.org_id)
    h = login_full(client, db, owner)
    add_ai_key(client, h)
    from tests.test_executor import RESTART  # noqa: PLC0415
    fake_provider.script = [__import__("tests.conftest", fromlist=["tool_turn"]).tool_turn(("propose_plan", {"title": "T", "summary": "S", "steps": [RESTART]})), text_turn("ок")]
    r = client.post(f"{API}/conversations/messages", headers=h, json={"serverId": str(srv.id), "text": "сделай"})
    plan = client.get(f"{API}/action-plans/{r.json()[1]['proposal']['planId']}").json()
    client.post(f"{API}/action-plans/{plan['id']}/approve", headers=h, json={"hash": plan["canonicalHash"], "revision": plan["revision"]})
    ha2 = login_full(client, db, admin)
    stop = client.put(f"{API}/admin/kill-switch", headers=ha2, json={"executionEnabled": False})
    assert stop.json() == {"executionEnabled": False, "configAllows": True, "engaged": True}
    h = login_full(client, db, owner)
    blocked = client.post(f"{API}/action-plans/{plan['id']}/rehearse", headers=h)
    assert blocked.status_code == 409 and blocked.json()["code"] == "execution_stopped"
    assert db.execute(text("SELECT count(*) FROM jobs")).scalar() == 0
    ha2 = login_full(client, db, admin)
    assert client.put(f"{API}/admin/kill-switch", headers=ha2, json={"executionEnabled": True}).json()["executionEnabled"] is True
    h = login_full(client, db, owner)
    assert client.post(f"{API}/action-plans/{plan['id']}/rehearse", headers=h).status_code == 202
    assert db.execute(text("SELECT count(*) FROM audit_events WHERE action='kill_switch.set'")).scalar() == 2


# ───────── приглашения и регистрация ─────────
def test_invite_registration_flow_and_first_login_requires_2fa_setup(client, db, ha):
    code = new_invite(client, ha)
    listing = client.get(f"{API}/admin/invites", headers=ha).json()
    assert listing[0]["code"] == code and listing[0]["usedBy"] is None
    client.cookies.clear()
    r = register(client, code, name="Новичок")
    assert r.status_code == 201 and r.json() == {"ok": True}
    login = client.post(f"{API}/auth/login", json={"email": "newbie@example.com", "password": NEW_PW})
    assert login.status_code == 200 and login.json()["twoFactorSetupRequired"] is True  # 2FA обязательна с первого входа
    assert db.execute(text("SELECT role FROM memberships m JOIN users u ON u.id=m.user_id WHERE u.email='newbie@example.com'")).scalar() == "owner"
    assert db.execute(text("SELECT count(*) FROM audit_events WHERE action='user.registered'")).scalar() == 1


def test_invite_is_single_use_and_errors_do_not_reveal_which_part_failed(client, db, owner, ha):
    code = new_invite(client, ha)
    assert db.execute(text("SELECT count(*) FROM audit_events WHERE meta::text LIKE :c"), {"c": f"%{code}%"}).scalar() == 0  # код не пишется в аудит
    client.cookies.clear()
    assert register(client, code).status_code == 201
    reuse = register(client, code, email="second@example.com")
    unknown = register(client, "totally-unknown-code-123", email="third@example.com")
    assert reuse.status_code == unknown.status_code == 422 and reuse.json() == unknown.json() and reuse.json()["code"] == "register_failed"
    assert db.execute(text("SELECT count(*) FROM users WHERE email IN ('second@example.com','third@example.com')")).scalar() == 0


def test_existing_email_gets_the_same_answer_as_a_bad_code(client, db, owner, ha):
    code = new_invite(client, ha)
    client.cookies.clear()
    taken = register(client, code, email=owner.email)
    bad = register(client, "totally-unknown-code-123", email="x@example.com")
    assert taken.status_code == bad.status_code == 422 and taken.json() == bad.json()
    assert db.execute(text("SELECT used_at FROM invites")).scalar() is None  # неудачная попытка не сжигает код


def test_expired_invite_and_weak_input_are_refused(client, db, ha):
    code = new_invite(client, ha)
    db.execute(text("UPDATE invites SET expires_at = now() - interval '1 minute'"))
    db.commit()
    client.cookies.clear()
    assert register(client, code).json()["code"] == "register_failed"


def test_registration_validation_and_flag(client, db, admin, ha):
    code = new_invite(client, ha)
    client.cookies.clear()
    assert register(client, code, password="short").json()["code"] == "validation"
    assert register(client, code, email="notanemail").json()["code"] == "validation"
    assert register(client, code, email="same-pass-0001@example.com", password="same-pass-0001@example.com").json()["code"] == "validation"
    assert client.post(f"{API}/auth/register", json={"email": "a@example.com", "password": NEW_PW, "inviteCode": "x"}).status_code == 422
    h = login_full(client, db, admin)
    client.put(f"{API}/admin/flags/registration", headers=h, json={"enabled": False})
    client.cookies.clear()
    r = register(client, code)
    assert r.status_code == 403 and r.json()["code"] == "registration_closed"
    assert db.execute(text("SELECT count(*) FROM users WHERE email='newbie@example.com'")).scalar() == 0


def test_registration_is_rate_limited_per_ip(client, db, ha):
    code = new_invite(client, ha)
    client.cookies.clear()
    statuses = [register(client, code, email=f"u{i}@example.com", password="short").status_code for i in range(11)]
    assert statuses[:10] == [422] * 10 and statuses[10] == 429


def test_concurrent_registrations_with_one_invite_create_one_account(db, ha, client):
    code = new_invite(client, ha)

    def attempt(i: int) -> int:
        with TestClient(create_app(), base_url="http://testserver") as c:
            return c.post(f"{API}/auth/register", json={"email": f"race{i}@example.com", "password": NEW_PW, "inviteCode": code}).status_code

    with ThreadPoolExecutor(max_workers=6) as pool:
        codes = list(pool.map(attempt, range(6)))
    assert codes.count(201) == 1 and codes.count(422) == 5
    assert db.execute(text("SELECT count(*) FROM users WHERE email LIKE 'race%'")).scalar() == 1


# ───────── пользователи ─────────
def test_disabling_a_user_blocks_login_and_kills_sessions(client, db, owner, admin, ha):
    users = client.get(f"{API}/admin/users", headers=ha).json()
    assert {u["email"] for u in users} == {"owner@example.com", "admin@example.com"} and all(u["active"] for u in users)
    # живая сессия владельца
    h_owner = login_full(client, db, owner)
    assert client.get(f"{API}/me").status_code == 200
    ha2 = login_full(client, db, admin)
    assert client.post(f"{API}/admin/users/{owner.id}/active", headers=ha2, json={"active": False}).json()["active"] is False
    assert db.execute(text("SELECT count(*) FROM sessions WHERE user_id = :u"), {"u": owner.id}).scalar() == 0
    client.cookies.clear()
    assert client.post(f"{API}/auth/login", json={"email": owner.email, "password": PASSWORD}).status_code == 401
    assert h_owner  # сессия до отключения больше недействительна
    ha3 = login_full(client, db, admin)
    assert client.post(f"{API}/admin/users/{owner.id}/active", headers=ha3, json={"active": True}).json()["active"] is True
    client.cookies.clear()
    assert client.post(f"{API}/auth/login", json={"email": owner.email, "password": PASSWORD}).status_code == 200
    assert db.execute(text("SELECT count(*) FROM audit_events WHERE action='user.active_set'")).scalar() == 2


def test_cannot_disable_yourself_or_unknown_user(client, admin, ha):
    assert client.post(f"{API}/admin/users/{admin.id}/active", headers=ha, json={"active": False}).json()["code"] == "self_disable"
    assert client.post(f"{API}/admin/users/00000000-0000-0000-0000-000000000000/active", headers=ha, json={"active": False}).status_code == 404
    assert client.post(f"{API}/admin/users/not-a-uuid/active", headers=ha, json={"active": False}).status_code == 404
