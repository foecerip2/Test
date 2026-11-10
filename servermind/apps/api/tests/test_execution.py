"""Реальное исполнение (ADR 0004): три выключателя, репетиция-предусловие, ровно один раз, остановка на первой ошибке, kill switch
между шагами, подмена ключа хоста, прерванный процесс. Сервер — настоящий протокол SSH (FakeSshd); команды — только обёртка."""

from __future__ import annotations

import datetime as dt
import json

import pytest
from sqlalchemy import text

from app.modules.admin import flags
from app.modules.executor import ops, runner
from app.modules.servers import ssh
from tests.conftest import PASSWORD, add_ai_key, login_full, make_user, set_env, text_turn, tool_turn
from tests.fake_sshd import FakeSshd

API = "/api/v1"
RESTART = {"tool": "service.restart", "params": {"unit": "nginx"}}
HEALTH = {"tool": "http.healthcheck", "params": {"url": "http://127.0.0.1:8080/healthz"}}
RESTART_CMD = ops.render("service.restart", {"unit": "nginx"})


@pytest.fixture
def h(client, db, owner):
    return login_full(client, db, owner)


@pytest.fixture
def world(client, db, owner, h, sshd: FakeSshd, fake_provider, monkeypatch):
    """Реальный онбординг сервера через API (по SSH), подтверждённый и отрепетированный план. Выключатели ещё ВЫКЛ."""
    key = client.get(f"{API}/servers/public-key").json()["key"]
    sshd.authorize(key)
    probe = client.post(f"{API}/servers/probe", json={"host": "127.0.0.1", "port": sshd.port}, headers=h).json()
    srv = client.post(f"{API}/servers", headers=h, json={"name": "t", "host": "127.0.0.1", "port": sshd.port, "username": "servermind",
                                                        "fingerprint": probe["fingerprint"]}).json()["server"]
    add_ai_key(client, h)

    class W:
        pass

    w = W()
    w.server_id, w.sshd = srv["id"], sshd

    def login():
        return login_full(client, db, owner)  # вход заново: cookie/CSRF предыдущего входа после этого недействительны

    w.login = login

    def new_plan(steps=(RESTART, HEALTH), *, approve=True, rehearse=True):
        h = login()
        fake_provider.script = [tool_turn(("propose_plan", {"title": "T", "summary": "S", "steps": list(steps)})), text_turn("ок")]
        r = client.post(f"{API}/conversations/messages", headers=h, json={"serverId": w.server_id, "text": "сделай"})
        plan = client.get(f"{API}/action-plans/{r.json()[1]['proposal']['planId']}").json()
        if approve:
            assert client.post(f"{API}/action-plans/{plan['id']}/approve", headers=h, json={"hash": plan["canonicalHash"], "revision": plan["revision"]}).status_code == 200
        if rehearse:
            client.post(f"{API}/action-plans/{plan['id']}/rehearse", headers=h)
            assert runner.run_once(db) is True
            db.expire_all()
        return plan

    w.new_plan = new_plan
    return w


def enable_all(client, db, owner, w, monkeypatch):
    set_env(monkeypatch, execution_enabled="true")
    h = login_full(client, db, owner)
    assert client.put(f"{API}/org/execution", headers=h, json={"enabled": True}).json() == {"orgEnabled": True}
    assert client.put(f"{API}/servers/{w.server_id}/execution", headers=h, json={"enabled": True}).json() == {"serverEnabled": True}
    return h


def execute(client, h, plan):
    return client.post(f"{API}/action-plans/{plan['id']}/execute", headers=h)


def work(db):
    assert runner.run_once(db) is True
    db.expire_all()


def job(client, jid):
    return client.get(f"{API}/jobs/{jid}").json()


# ───────── выключатели ─────────
def test_everything_is_off_by_default_and_nothing_reaches_the_server(client, db, world):
    plan = world.new_plan()
    h = world.login()
    before = len(world.sshd.commands)
    r = execute(client, h, plan)
    assert r.status_code == 409 and r.json()["code"] == "execution_not_allowed"
    for part in ("конфигурацией сервера", "для организации", "для этого сервера"):
        assert part in r.json()["message"]
    assert db.execute(text("SELECT count(*) FROM jobs WHERE mode='execute'")).scalar() == 0
    assert world.sshd.wrapper_commands == [] and len(world.sshd.commands) == before
    st = client.get(f"{API}/execution/status?serverId={world.server_id}", headers=h).json()
    assert st["effective"] is False and (st["configAllows"], st["orgEnabled"], st["serverEnabled"]) == (False, False, False)
    assert st["supportedOperations"] == ["http.healthcheck", "service.restart"]


@pytest.mark.parametrize("off", ["config", "org", "server", "kill"])
def test_each_switch_alone_blocks_execution(client, db, owner, world, monkeypatch, off):
    plan = world.new_plan()
    h = enable_all(client, db, owner, world, monkeypatch)
    if off == "config":
        set_env(monkeypatch, execution_enabled="false")
    elif off == "org":
        client.put(f"{API}/org/execution", headers=h, json={"enabled": False})
    elif off == "server":
        client.put(f"{API}/servers/{world.server_id}/execution", headers=h, json={"enabled": False})
    else:
        flags.set_value(db, flags.KILL, True, None)
        db.commit()
    r = execute(client, h, plan)
    assert r.status_code == 409 and r.json()["code"] == "execution_not_allowed"
    assert world.sshd.wrapper_commands == [] and db.execute(text("SELECT count(*) FROM jobs WHERE mode='execute'")).scalar() == 0


def test_only_the_owner_can_flip_switches_and_viewers_cannot_execute(client, db, owner, world, monkeypatch):
    plan = world.new_plan()
    op = make_user(db, "op@example.com", role="operator", org_id=owner.org_id)
    hop = login_full(client, db, op)
    assert client.put(f"{API}/org/execution", headers=hop, json={"enabled": True}).status_code == 403
    assert client.put(f"{API}/servers/{world.server_id}/execution", headers=hop, json={"enabled": True}).status_code == 403
    v = make_user(db, "v@example.com", role="viewer", org_id=owner.org_id, totp=False)
    client.cookies.clear()
    hv = {"X-CSRF-Token": client.post(f"{API}/auth/login", json={"email": v.email, "password": PASSWORD}).json()["csrfToken"]}
    assert execute(client, hv, plan).status_code == 403
    other = make_user(db, "other@example.com")
    ho = login_full(client, db, other)
    assert execute(client, ho, plan).status_code == 404
    assert client.put(f"{API}/servers/{world.server_id}/execution", headers=ho, json={"enabled": True}).status_code == 404


def test_rehearsal_and_approval_are_prerequisites(client, db, owner, world, monkeypatch):
    unapproved = world.new_plan(approve=False, rehearse=False)
    h = enable_all(client, db, owner, world, monkeypatch)
    assert execute(client, h, unapproved).json()["code"] == "plan_not_approved"
    approved_only = world.new_plan(rehearse=False)
    r = execute(client, world.login(), approved_only)
    assert r.status_code == 409 and r.json()["code"] == "rehearsal_required"
    assert world.sshd.wrapper_commands == []


# ───────── успешное исполнение ─────────
def test_happy_path_sends_only_the_wrapper_commands_and_records_everything(client, db, owner, world, monkeypatch):
    plan = world.new_plan()
    h = enable_all(client, db, owner, world, monkeypatch)
    before = list(world.sshd.commands)
    r = execute(client, h, plan)
    assert r.status_code == 202 and r.json()["mode"] == "execute" and r.json()["executesOnServer"] is True
    work(db)
    j = job(client, r.json()["id"])
    assert j["status"] == "succeeded" and j["summary"] == "Исполнено шагов: 2 из 2." and [s["status"] for s in j["steps"]] == ["executed", "executed"]
    new = world.sshd.commands[len(before):]
    assert new == world.sshd.wrapper_commands and len(new) == 2 and new[0] == RESTART_CMD  # НИЧЕГО, кроме вызовов обёртки
    assert all(c.startswith(ssh.WRAPPER_PREFIX) for c in new)
    assert j["steps"][0]["plannedAction"] == RESTART_CMD and j["steps"][0]["output"] == "fake ok"
    assert db.execute(text("SELECT count(*) FROM audit_events WHERE action IN ('job.step_started','job.step_finished')")).scalar() == 4
    assert "BEGIN OPENSSH" not in json.dumps(j) and "PRIVATE" not in json.dumps(j)


def test_execution_happens_exactly_once_per_plan_revision(client, db, owner, world, monkeypatch):
    plan = world.new_plan()
    h = enable_all(client, db, owner, world, monkeypatch)
    jid = execute(client, h, plan).json()["id"]
    work(db)
    again = execute(client, h, plan)
    assert again.status_code == 409 and again.json()["code"] == "already_executed"
    assert runner.run_once(db) is False and len(world.sshd.wrapper_commands) == 2
    assert job(client, jid)["status"] == "succeeded"


def test_only_one_active_execution_per_server(client, db, owner, world, monkeypatch):
    p1, p2 = world.new_plan(), world.new_plan()
    h = enable_all(client, db, owner, world, monkeypatch)
    assert execute(client, h, p1).status_code == 202
    second = execute(client, h, p2)  # первое ещё в очереди
    assert second.status_code == 409 and second.json()["code"] == "execution_in_progress"
    assert db.execute(text("SELECT count(*) FROM jobs WHERE mode='execute'")).scalar() == 1


# ───────── сбои ─────────
def test_wrapper_failure_stops_the_plan_and_is_never_retried(client, db, owner, world, monkeypatch):
    plan = world.new_plan()
    h = enable_all(client, db, owner, world, monkeypatch)
    world.sshd.wrapper = lambda cmd: (1, json.dumps({"ok": False, "op": "service.restart", "detail": "nginx.service: не стала active"}))
    jid = execute(client, h, plan).json()["id"]
    work(db)
    j = job(client, jid)
    assert j["status"] == "failed" and [s["status"] for s in j["steps"]] == ["failed", "skipped"]
    assert "не стала active" in j["steps"][0]["output"] and "Откат автоматически не выполняется" in j["summary"]
    assert len(world.sshd.wrapper_commands) == 1  # второй шаг НЕ отправлен
    assert runner.run_once(db) is False  # автоповтора нет


@pytest.mark.parametrize("reply", [(127, "sudo: servermind-op: command not found"), (0, "не JSON"), (0, json.dumps({"ok": "yes"})), (2, json.dumps({"ok": True, "detail": "x"}))])
def test_unclear_wrapper_answers_count_as_failure(client, db, owner, world, monkeypatch, reply):
    plan = world.new_plan(steps=(RESTART,))
    h = enable_all(client, db, owner, world, monkeypatch)
    world.sshd.wrapper = lambda cmd: reply
    jid = execute(client, h, plan).json()["id"]
    work(db)
    assert job(client, jid)["status"] == "failed"


def test_kill_switch_between_steps_stops_the_rest(client, db, owner, world, monkeypatch):
    plan = world.new_plan()
    h = enable_all(client, db, owner, world, monkeypatch)
    from app.db.session import _factory  # noqa: PLC0415

    def press_kill(cmd):
        with _factory()() as s:  # администратор нажимает kill switch, пока выполняется первый шаг
            flags.set_value(s, flags.KILL, True, None)
            s.commit()
        return 0, json.dumps({"ok": True, "op": "service.restart", "detail": "ok"})

    world.sshd.wrapper = press_kill
    jid = execute(client, h, plan).json()["id"]
    work(db)
    j = job(client, jid)
    assert j["status"] == "failed" and [s["status"] for s in j["steps"]] == ["executed", "blocked"]
    assert any(c["name"] == "kill_switch" and not c["ok"] for c in j["steps"][1]["checks"])
    assert len(world.sshd.wrapper_commands) == 1 and "Исполнено шагов: 1 из 2" in j["summary"]


def test_changed_host_key_blocks_before_any_command(client, db, owner, world, monkeypatch):
    plan = world.new_plan(steps=(RESTART,))
    h = enable_all(client, db, owner, world, monkeypatch)
    jid = execute(client, h, plan).json()["id"]
    world.sshd.restart_with_new_host_key()  # «подмена сервера»
    work(db)
    j = job(client, jid)
    assert j["status"] == "failed" and "подмена сервера" in j["steps"][0]["output"] and world.sshd.wrapper_commands == []


def test_tampered_plan_after_queueing_is_blocked_without_commands(client, db, owner, world, monkeypatch):
    plan = world.new_plan()
    h = enable_all(client, db, owner, world, monkeypatch)
    jid = execute(client, h, plan).json()["id"]
    db.execute(text("UPDATE action_plans SET steps = jsonb_set(steps, '{0,params,unit}', '\"sshd\"') WHERE id = :i"), {"i": plan["id"]})
    db.commit()
    work(db)
    j = job(client, jid)
    assert j["status"] == "blocked" and "ничего не выполнялось" in j["summary"] and world.sshd.wrapper_commands == []


def test_switch_turned_off_after_queueing_blocks_the_job(client, db, owner, world, monkeypatch):
    plan = world.new_plan()
    h = enable_all(client, db, owner, world, monkeypatch)
    jid = execute(client, h, plan).json()["id"]
    client.put(f"{API}/servers/{world.server_id}/execution", headers=h, json={"enabled": False})
    work(db)
    j = job(client, jid)
    assert j["status"] == "blocked" and world.sshd.wrapper_commands == []


def test_unsupported_operations_are_blocked_even_when_everything_is_on(client, db, owner, world, monkeypatch):
    plan = world.new_plan(steps=({"tool": "docker.install", "params": {}},), rehearse=False)
    h = enable_all(client, db, owner, world, monkeypatch)
    # репетиция такого плана блокируется, значит исполнение вообще не стартует
    client.post(f"{API}/action-plans/{plan['id']}/rehearse", headers=h)
    work(db)
    assert execute(client, h, plan).json()["code"] == "rehearsal_required" and world.sshd.wrapper_commands == []


def test_interrupted_execution_is_never_restarted(client, db, owner, world, monkeypatch):
    plan = world.new_plan()
    h = enable_all(client, db, owner, world, monkeypatch)
    jid = execute(client, h, plan).json()["id"]
    now = dt.datetime.now(dt.UTC)
    first = runner.claim_next(db, now=now)  # воркер взял задание и «упал»
    assert str(first.id) == jid
    assert runner.claim_next(db, now=now + dt.timedelta(seconds=runner.LEASE_SECONDS + 5)) is None  # повторно НЕ выдаётся
    db.expire_all()
    j = job(client, jid)
    assert j["status"] == "failed" and "Автоповтор запрещён" in j["summary"] and world.sshd.wrapper_commands == []
    assert db.execute(text("SELECT count(*) FROM audit_events WHERE action='job.interrupted'")).scalar() == 1


# ───────── слой SSH ─────────
def test_ssh_layer_refuses_anything_but_the_wrapper(monkeypatch):
    import asyncio  # noqa: PLC0415

    async def must_not_connect(*a, **k):
        raise AssertionError("подключение не должно начинаться для чужой команды")

    monkeypatch.setattr(ssh, "_connect", must_not_connect)
    for bad in ("id", "cat /etc/shadow", "sudo -n /usr/local/sbin/other-tool x", ssh.WRAPPER_PREFIX + "x\nid", ssh.WRAPPER_PREFIX.strip()):
        with pytest.raises(ValueError, match="только вызов servermind-op"):
            asyncio.run(ssh.run_wrapper("127.0.0.1", 1, "u", "k", "h", bad, connect_timeout=1, command_timeout=1, cap=10))


def test_ops_command_is_exactly_the_wrapper_with_quoted_json():
    cmd = ops.render("http.healthcheck", {"url": "http://127.0.0.1:8080/healthz", "expect_status": 200, "timeout_s": 10})
    assert cmd.startswith(ssh.WRAPPER_PREFIX) and "\n" not in cmd
