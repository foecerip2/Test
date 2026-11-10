import datetime as dt

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app.modules.policy.plan_hash import compute_hash
from tests.conftest import PASSWORD, add_ai_key, login_full, make_server, make_user, text_turn, tool_turn

API = "/api/v1"
PLAN = {"title": "Перезапуск nginx", "summary": "nginx упал", "steps": [
    {"tool": "service.restart", "params": {"unit": "nginx"}},
    {"tool": "http.healthcheck", "params": {"url": "http://127.0.0.1:8080/healthz"}}]}


@pytest.fixture
def h(client, db, owner):
    return login_full(client, db, owner)


@pytest.fixture
def plan(client, db, owner, h, fake_provider):
    srv = make_server(db, owner.org_id)
    add_ai_key(client, h)
    fake_provider.script = [tool_turn(("propose_plan", PLAN)), text_turn("готово")]
    r = client.post(f"{API}/conversations/messages", headers=h, json={"serverId": str(srv.id), "text": "почини"})
    pid = r.json()[1]["proposal"]["planId"]
    return client.get(f"{API}/action-plans/{pid}").json()


def approve(client, h, p, **over):
    body = {"hash": p["canonicalHash"], "revision": p["revision"], **over}
    return client.post(f"{API}/action-plans/{p['id']}/approve", headers=h, json=body)


def as_viewer(client, db, owner):
    v = make_user(db, "viewer@example.com", role="viewer", org_id=owner.org_id, totp=False)
    client.cookies.clear()
    r = client.post(f"{API}/auth/login", json={"email": v.email, "password": PASSWORD})
    return {"X-CSRF-Token": r.json()["csrfToken"]}


def test_plan_shape_and_hash_is_verifiable_client_side(plan):
    assert plan["status"] == "waiting_approval" and plan["revision"] == 1 and len(plan["canonicalHash"]) == 64
    assert plan["expiresAt"].endswith("Z") and len(plan["expiresAt"]) == 20  # ровно та строка, которая входит в хеш
    assert [s["tool"] for s in plan["steps"]] == ["service.restart", "http.healthcheck"] and plan["steps"][1]["optional"] is True
    # браузер пересчитывает хеш по показанным данным — результат обязан совпасть с серверным
    assert compute_hash(plan["id"], plan["serverId"], plan["revision"], plan["expiresAt"], plan["steps"]) == plan["canonicalHash"]
    assert plan["serverName"] == "web-1" and plan["downtime"]


def test_no_endpoint_creates_plans_outside_policy(client, h):
    for method, path in [("post", "/action-plans"), ("put", "/action-plans/x")]:
        assert getattr(client, method)(API + path, headers=h, json={}).status_code in (404, 405)


def test_approve_records_consent_only_and_executes_nothing(client, db, h, plan):
    r = approve(client, h, plan)
    assert r.status_code == 200
    assert r.json()["status"] == "approved" and r.json()["executionAvailable"] is False and "ничего не выполнено" in r.json()["message"]
    row = db.execute(text("SELECT revision, canonical_hash FROM approvals")).one()
    assert tuple(row) == (1, plan["canonicalHash"])
    assert client.get(f"{API}/action-plans/{plan['id']}").json()["status"] == "approved"
    assert db.execute(text("SELECT count(*) FROM audit_events WHERE action='plan.approved'")).scalar() == 1
    again = approve(client, h, plan)
    assert again.status_code == 409 and again.json()["code"] == "plan_closed"
    assert db.execute(text("SELECT count(*) FROM approvals")).scalar() == 1  # ровно одно подтверждение


def test_wrong_hash_or_revision_is_refused(client, db, h, plan):
    bad = approve(client, h, plan, hash="0" * 64)
    assert bad.status_code == 409 and bad.json()["code"] == "hash_mismatch"
    assert approve(client, h, plan, revision=2).json()["code"] == "revision_mismatch"
    assert approve(client, h, plan, hash=plan["canonicalHash"].upper()).json()["code"] == "hash_mismatch"
    assert db.execute(text("SELECT count(*) FROM approvals")).scalar() == 0
    assert client.get(f"{API}/action-plans/{plan['id']}").json()["status"] == "waiting_approval"
    assert db.execute(text("SELECT count(*) FROM audit_events WHERE action='plan.approval_refused'")).scalar() == 2


def test_changing_the_plan_invalidates_previous_approval(client, db, h, plan):
    r = client.post(f"{API}/action-plans/{plan['id']}/steps/s2", headers=h, json={"enabled": False})
    assert r.status_code == 200
    new = r.json()
    assert new["revision"] == 2 and new["canonicalHash"] != plan["canonicalHash"] and new["steps"][1]["enabled"] is False
    assert compute_hash(new["id"], new["serverId"], 2, new["expiresAt"], new["steps"]) == new["canonicalHash"]
    stale = approve(client, h, plan)  # подтверждение по тому, что человек видел ДО изменения
    assert stale.status_code == 409 and stale.json()["code"] == "revision_mismatch"
    assert approve(client, h, new).status_code == 200
    assert db.execute(text("SELECT revision FROM approvals")).scalar() == 2


def test_required_step_cannot_be_disabled_and_unknown_step_404(client, h, plan):
    assert client.post(f"{API}/action-plans/{plan['id']}/steps/s1", headers=h, json={"enabled": False}).json()["code"] == "step_required"
    assert client.post(f"{API}/action-plans/{plan['id']}/steps/s99", headers=h, json={"enabled": False}).status_code == 404


def test_expired_plan_cannot_be_approved(client, db, h, plan):
    db.execute(text("UPDATE action_plans SET expires_at = :t"), {"t": dt.datetime.now(dt.UTC) - dt.timedelta(seconds=1)})
    db.commit()
    r = approve(client, h, plan)
    assert r.status_code == 409 and r.json()["code"] == "plan_expired"
    assert client.get(f"{API}/action-plans/{plan['id']}").json()["status"] == "expired"
    assert client.post(f"{API}/action-plans/{plan['id']}/steps/s2", headers=h, json={"enabled": False}).status_code == 409
    assert db.execute(text("SELECT count(*) FROM approvals")).scalar() == 0


def test_tampered_plan_in_database_is_detected_on_approval(client, db, h, plan):
    """Кто-то подменил шаги в БД (nginx → sshd), оставив хеш прежним: человек видел «хороший» хеш, но данные уже другие."""
    db.execute(text("UPDATE action_plans SET steps = replace(steps::text, 'nginx', 'sshd')::jsonb"))
    db.commit()
    r = approve(client, h, plan)
    assert r.status_code == 409 and r.json()["code"] == "hash_mismatch"
    assert db.execute(text("SELECT count(*) FROM approvals")).scalar() == 0
    assert db.execute(text("SELECT status FROM action_plans")).scalar() == "waiting_approval"
    assert "integrity" in str(db.execute(text("SELECT meta::text FROM audit_events WHERE action='plan.approval_refused'")).scalar())


def test_reject_closes_plan(client, db, h, plan):
    r = client.post(f"{API}/action-plans/{plan['id']}/reject", headers=h)
    assert r.status_code == 200 and r.json()["status"] == "rejected"
    assert approve(client, h, plan).json()["code"] == "plan_closed"
    assert client.post(f"{API}/action-plans/{plan['id']}/reject", headers=h).status_code == 409


def test_viewer_can_read_but_not_change_or_approve(client, db, owner, h, plan):
    hv = as_viewer(client, db, owner)
    assert client.get(f"{API}/action-plans/{plan['id']}").status_code == 200
    assert approve(client, hv, plan).status_code == 403
    assert client.post(f"{API}/action-plans/{plan['id']}/reject", headers=hv).status_code == 403
    assert client.post(f"{API}/action-plans/{plan['id']}/steps/s2", headers=hv, json={"enabled": False}).status_code == 403
    assert db.execute(text("SELECT count(*) FROM approvals")).scalar() == 0


def test_operator_may_approve(client, db, owner, h, plan):
    op = make_user(db, "op@example.com", role="operator", org_id=owner.org_id)
    hop = login_full(client, db, op)
    assert approve(client, hop, plan).status_code == 200
    assert str(db.execute(text("SELECT actor_user_id FROM approvals")).scalar()) == str(op.id)  # подпись привязана к актору


def test_other_tenant_cannot_see_or_approve(client, db, plan):
    other = make_user(db, "mallory@example.com", role="owner")
    h2 = login_full(client, db, other)
    assert client.get(f"{API}/action-plans/{plan['id']}").status_code == 404
    assert approve(client, h2, plan).status_code == 404
    assert client.post(f"{API}/action-plans/{plan['id']}/reject", headers=h2).status_code == 404
    assert client.post(f"{API}/action-plans/{plan['id']}/steps/s2", headers=h2, json={"enabled": False}).status_code == 404
    assert db.execute(text("SELECT status FROM action_plans")).scalar() == "waiting_approval"


def test_csrf_and_auth_required(client, h, plan):
    body = {"hash": plan["canonicalHash"], "revision": 1}
    assert client.post(f"{API}/action-plans/{plan['id']}/approve", json=body).json()["code"] == "csrf"
    client.cookies.clear()
    assert client.get(f"{API}/action-plans/{plan['id']}").status_code == 401
    assert client.get(f"{API}/action-plans/not-a-uuid").status_code == 401


def test_approvals_are_append_only(client, db, h, plan):
    approve(client, h, plan)
    with pytest.raises(DBAPIError):
        db.execute(text("UPDATE approvals SET revision = 99"))
    db.rollback()
    with pytest.raises(DBAPIError):
        db.execute(text("DELETE FROM approvals"))
    db.rollback()


def test_malformed_ids_are_404(client, h):
    assert client.get(f"{API}/action-plans/not-a-uuid").status_code == 404
