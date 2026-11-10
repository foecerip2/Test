"""Исполнитель в режиме «репетиция» (ADR 0004): очередь, перепроверка перед каждым шагом, идемпотентность, изоляция,
append-only журнал и гарантия, что SSH не используется."""

from __future__ import annotations

import datetime as dt

import asyncssh
import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.modules.executor import ops, runner
from tests.conftest import PASSWORD, add_ai_key, login_full, make_server, make_user, text_turn, tool_turn

API = "/api/v1"
RESTART = {"tool": "service.restart", "params": {"unit": "nginx"}}
HEALTH = {"tool": "http.healthcheck", "params": {"url": "http://127.0.0.1:8080/healthz"}}
DOCKER = {"tool": "docker.install", "params": {}}


@pytest.fixture
def h(client, db, owner):
    return login_full(client, db, owner)


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    """Любая попытка подключиться по SSH во время репетиции = падение теста."""
    def boom(*a, **k):
        raise AssertionError("репетиция не должна подключаться по SSH")
    monkeypatch.setattr(asyncssh, "connect", boom)
    monkeypatch.setattr(asyncssh, "get_server_host_key", boom)


def make_plan(client, db, owner, h, fake_provider, steps, *, approve=True):
    srv = make_server(db, owner.org_id)
    add_ai_key(client, h)
    fake_provider.script = [tool_turn(("propose_plan", {"title": "T", "summary": "S", "steps": steps})), text_turn("ок")]
    r = client.post(f"{API}/conversations/messages", headers=h, json={"serverId": str(srv.id), "text": "сделай"})
    plan = client.get(f"{API}/action-plans/{r.json()[1]['proposal']['planId']}").json()
    if approve:
        a = client.post(f"{API}/action-plans/{plan['id']}/approve", headers=h, json={"hash": plan["canonicalHash"], "revision": plan["revision"]})
        assert a.status_code == 200 and a.json()["rehearsalAvailable"] is True
    return plan, srv


def rehearse(client, h, plan):
    return client.post(f"{API}/action-plans/{plan['id']}/rehearse", headers=h)


def work(db):
    assert runner.run_once(db) is True
    db.expire_all()


def get_job(client, job_id):
    return client.get(f"{API}/jobs/{job_id}").json()


def failed_checks(job, index=0):
    return [c["name"] for c in job["steps"][index]["checks"] if not c["ok"]]


def test_unapproved_plan_cannot_be_rehearsed(client, db, owner, h, fake_provider):
    plan, _ = make_plan(client, db, owner, h, fake_provider, [RESTART], approve=False)
    r = rehearse(client, h, plan)
    assert r.status_code == 409 and r.json()["code"] == "plan_not_approved"
    assert db.execute(text("SELECT count(*) FROM jobs")).scalar() == 0


def test_happy_rehearsal_checks_everything_and_touches_nothing(client, db, owner, h, fake_provider):
    plan, _ = make_plan(client, db, owner, h, fake_provider, [RESTART, HEALTH])
    r = rehearse(client, h, plan)
    assert r.status_code == 202 and r.json()["status"] == "queued" and r.json()["mode"] == "rehearsal"
    work(db)
    j = get_job(client, r.json()["id"])
    assert j["status"] == "succeeded" and j["executesOnServer"] is False and "ничего не выполнялось" in j["summary"]
    assert [s["status"] for s in j["steps"]] == ["rehearsed", "rehearsed"]
    assert j["title"].startswith("Репетиция: ") and j["risk"] == "R2" and j["actor"] == "owner" and (j["stepsDone"], j["stepsTotal"]) == (2, 2)
    assert client.get(f"{API}/jobs").json()[0]["stepsDone"] == 2
    assert j["steps"][0]["plannedAction"] == "sudo -n /usr/local/sbin/servermind-op service.restart '{\"unit\":\"nginx\"}'"
    names = {c["name"] for c in j["steps"][0]["checks"]}
    assert {"plan_approved", "approval_matches", "hash_integrity", "not_expired", "approver_authorized", "server_ready", "policy",
            "operation_supported"} <= names and all(c["ok"] for c in j["steps"][0]["checks"])
    assert db.execute(text("SELECT count(*) FROM audit_events WHERE action IN ('job.queued','job.finished')")).scalar() == 2


def test_rehearsal_is_idempotent_per_revision(client, db, owner, h, fake_provider):
    plan, _ = make_plan(client, db, owner, h, fake_provider, [RESTART])
    a, b = rehearse(client, h, plan), rehearse(client, h, plan)
    assert a.status_code == 202 and b.status_code == 200 and a.json()["id"] == b.json()["id"]
    assert db.execute(text("SELECT count(*) FROM jobs")).scalar() == 1
    assert runner.run_once(db) is True and runner.run_once(db) is False  # второй раз работы нет


def test_unsupported_operation_is_blocked_and_rest_skipped(client, db, owner, h, fake_provider):
    plan, _ = make_plan(client, db, owner, h, fake_provider, [DOCKER, RESTART])
    jid = rehearse(client, h, plan).json()["id"]
    work(db)
    j = get_job(client, jid)
    assert j["status"] == "blocked" and "docker.install" in j["summary"]
    assert [s["status"] for s in j["steps"]] == ["blocked", "skipped"] and all(not s["plannedAction"] for s in j["steps"])


def test_first_step_ok_second_unsupported_stops_there(client, db, owner, h, fake_provider):
    plan, _ = make_plan(client, db, owner, h, fake_provider, [RESTART, DOCKER])
    jid = rehearse(client, h, plan).json()["id"]
    work(db)
    j = get_job(client, jid)
    assert j["status"] == "blocked" and [s["status"] for s in j["steps"]] == ["rehearsed", "blocked"]


def test_tampered_plan_in_db_is_detected(client, db, owner, h, fake_provider):
    plan, _ = make_plan(client, db, owner, h, fake_provider, [RESTART])
    jid = rehearse(client, h, plan).json()["id"]
    db.execute(text("UPDATE action_plans SET steps = jsonb_set(steps, '{0,params,unit}', '\"sshd\"') WHERE id = :i"), {"i": plan["id"]})
    db.commit()
    work(db)
    j = get_job(client, jid)
    assert j["status"] == "blocked" and j["steps"][0]["plannedAction"] == "" and "hash_integrity" in failed_checks(j)


def test_expired_approval_is_blocked(client, db, owner, h, fake_provider):
    plan, _ = make_plan(client, db, owner, h, fake_provider, [RESTART])
    jid = rehearse(client, h, plan).json()["id"]
    db.execute(text("UPDATE action_plans SET expires_at = :t WHERE id = :i"),
               {"t": dt.datetime.now(dt.UTC) - dt.timedelta(minutes=1), "i": plan["id"]})
    db.commit()
    work(db)
    j = get_job(client, jid)
    assert j["status"] == "blocked" and "not_expired" in failed_checks(j)


def test_offline_server_is_blocked(client, db, owner, h, fake_provider):
    plan, srv = make_plan(client, db, owner, h, fake_provider, [RESTART])
    jid = rehearse(client, h, plan).json()["id"]
    db.execute(text("UPDATE servers SET status='offline' WHERE id = :i"), {"i": srv.id})
    db.commit()
    work(db)
    j = get_job(client, jid)
    assert j["status"] == "blocked" and {"server_ready", "policy"} <= set(failed_checks(j))


def test_approver_who_lost_rights_is_blocked(client, db, owner, h, fake_provider):
    plan, _ = make_plan(client, db, owner, h, fake_provider, [RESTART])
    jid = rehearse(client, h, plan).json()["id"]
    db.execute(text("UPDATE memberships SET role='viewer' WHERE user_id = :u"), {"u": owner.id})
    db.commit()
    work(db)
    assert failed_checks(get_job(client, jid)) == ["approver_authorized"]


def test_policy_is_reevaluated_on_fresh_data(client, db, owner, h, fake_provider):
    plan, _ = make_plan(client, db, owner, h, fake_provider, [RESTART])
    jid = rehearse(client, h, plan).json()["id"]
    db.execute(text("UPDATE server_metric_samples SET services = '[]'::jsonb"))  # служба nginx пропала с сервера
    db.commit()
    work(db)
    j = get_job(client, jid)
    pol = next(c for c in j["steps"][0]["checks"] if c["name"] == "policy")
    assert j["status"] == "blocked" and not pol["ok"] and "nginx" in pol["detail"]


def test_isolation_and_roles(client, db, owner, h, fake_provider):
    plan, _ = make_plan(client, db, owner, h, fake_provider, [RESTART])
    jid = rehearse(client, h, plan).json()["id"]
    v = make_user(db, "viewer@example.com", role="viewer", org_id=owner.org_id, totp=False)
    client.cookies.clear()
    csrf = client.post(f"{API}/auth/login", json={"email": v.email, "password": PASSWORD}).json()["csrfToken"]
    hv = {"X-CSRF-Token": csrf}
    assert client.post(f"{API}/action-plans/{plan['id']}/rehearse", headers=hv).status_code == 403  # viewer не запускает
    assert client.get(f"{API}/jobs/{jid}").status_code == 200 and len(client.get(f"{API}/jobs").json()) == 1
    other = make_user(db, "other@example.com", role="owner")
    ho = login_full(client, db, other)
    assert client.post(f"{API}/action-plans/{plan['id']}/rehearse", headers=ho).status_code == 404  # чужая организация
    assert client.get(f"{API}/jobs/{jid}").status_code == 404 and client.get(f"{API}/jobs").json() == []
    assert client.get(f"{API}/jobs/not-a-uuid").status_code == 404


def test_requires_login(client):
    assert client.get(f"{API}/jobs").status_code == 401
    assert client.post(f"{API}/action-plans/x/rehearse").status_code in (401, 403)


def test_db_forbids_real_execution_mode_and_rewriting_the_journal(client, db, owner, h, fake_provider):
    plan, _ = make_plan(client, db, owner, h, fake_provider, [RESTART])
    jid = rehearse(client, h, plan).json()["id"]
    work(db)
    with pytest.raises(IntegrityError):  # режим «execute» невозможно создать даже прямой записью в БД
        db.execute(text("UPDATE jobs SET mode='execute' WHERE id = :i"), {"i": jid})
        db.commit()
    db.rollback()
    with pytest.raises(DBAPIError):
        db.execute(text("UPDATE job_steps SET status='rehearsed', planned_action='x' WHERE job_id = :i"), {"i": jid})
        db.commit()
    db.rollback()


def test_stale_lease_is_recovered_and_active_lease_is_not_stolen(client, db, owner, h, fake_provider):
    plan, _ = make_plan(client, db, owner, h, fake_provider, [RESTART])
    jid = rehearse(client, h, plan).json()["id"]
    now = dt.datetime.now(dt.UTC)
    first = runner.claim_next(db, now=now)
    assert str(first.id) == jid and first.status == "running"
    assert runner.claim_next(db, now=now + dt.timedelta(seconds=10)) is None  # аренда ещё действует
    again = runner.claim_next(db, now=now + dt.timedelta(seconds=runner.LEASE_SECONDS + 5))  # воркер «упал»
    assert again is not None and str(again.id) == jid


def test_ops_render_revalidates_and_quotes():
    ok = ops.render("http.healthcheck", {"url": "http://127.0.0.1:8080/x", "expect_status": 200, "timeout_s": 10})
    assert ok.startswith("sudo -n /usr/local/sbin/servermind-op http.healthcheck '")
    for bad_tool, bad in [("service.restart", {"unit": "nginx; echo pwned"}), ("service.restart", {"unit": "nginx", "x": 1}),
                          ("shell", {}), ("domain.configure_https", {"domain": "a.example.com"})]:
        with pytest.raises(ops.OpError):
            ops.render(bad_tool, bad)
    assert ops.SUPPORTED == {"service.restart", "http.healthcheck"}
