import pytest
from sqlalchemy import text

from app.core.config import get_settings
from app.core.security import DecryptionError, decrypt
from app.modules.servers.ssh import ALLOWED_COMMANDS
from tests.conftest import login_full, make_user, set_env
from tests.fake_sshd import FakeSshd

API = "/api/v1"


def _onboard(client, h, sshd: FakeSshd, *, name="demo", username="servermind", authorize=True):
    key = client.get(f"{API}/servers/public-key").json()["key"]
    if authorize:
        sshd.authorize(key)
    probe = client.post(f"{API}/servers/probe", json={"host": "127.0.0.1", "port": sshd.port}, headers=h)
    assert probe.status_code == 200, probe.text
    return probe.json(), client.post(f"{API}/servers", headers=h, json={
        "name": name, "host": "127.0.0.1", "port": sshd.port, "username": username, "fingerprint": probe.json()["fingerprint"]})


@pytest.fixture
def h(client, db, owner):
    return login_full(client, db, owner)


def test_public_key_is_generated_once_and_private_key_stored_encrypted(client, db, h, owner):
    k1 = client.get(f"{API}/servers/public-key").json()["key"]
    k2 = client.get(f"{API}/servers/public-key").json()["key"]
    assert k1 == k2 and k1.startswith("ssh-ed25519 ")
    blob = bytes(db.execute(text("SELECT ciphertext FROM server_credentials")).scalar())
    assert b"PRIVATE KEY" not in blob and b"openssh-key-v1" not in blob
    s = get_settings()
    pem = decrypt(s.master_key_bytes, blob, f"cred:{owner.org_id}:ssh_private_key".encode()).decode()
    assert "BEGIN OPENSSH PRIVATE KEY" in pem
    with pytest.raises(DecryptionError):  # ключ нельзя расшифровать в контексте другой организации
        decrypt(s.master_key_bytes, blob, b"cred:other-org:ssh_private_key")


def test_probe_returns_real_host_key_fingerprint(client, h, sshd):
    r = client.post(f"{API}/servers/probe", json={"host": "127.0.0.1", "port": sshd.port}, headers=h)
    assert r.status_code == 200
    assert r.json() == {"fingerprint": sshd.fingerprint, "keyType": "ssh-ed25519", "source": "ssh"}


def test_add_server_collects_real_readonly_facts_with_allowlisted_commands(client, db, h, sshd):
    _, r = _onboard(client, h, sshd, name="web-1")
    assert r.status_code == 201, r.text
    srv = r.json()["server"]
    assert r.json()["os"] == "Ubuntu 24.04.1 LTS"
    assert (srv["status"], srv["cpuPercent"], srv["ramUsedMb"], srv["ramTotalMb"]) == ("online", 50.0, 2048, 4096)
    assert (srv["diskUsedGb"], srv["diskTotalGb"], srv["uptimeSeconds"]) == (12.0, 40.0, 1566000)
    assert srv["fingerprint"] == sshd.fingerprint and srv["lastCheckedAt"]
    assert {(s["name"], s["state"]) for s in srv["services"]} == {("ssh", "active"), ("nginx", "active"), ("docker", "failed")}
    # ровно разрешённые команды, ничего лишнего
    assert set(sshd.commands) == set(ALLOWED_COMMANDS.values()) and len(sshd.commands) == len(ALLOWED_COMMANDS)

    m = client.get(f"{API}/servers/{srv['id']}/metrics?hours=1").json()
    assert m["intervalSec"] == 0 and len(m["samples"]) == 1
    p = m["samples"][0]
    assert (p["cpu"], p["ram"], p["disk"]) == (50.0, 50.0, 30.0)
    assert client.get(f"{API}/servers/{srv['id']}/services").json()
    assert [s["name"] for s in client.get(f"{API}/servers").json()] == ["web-1"]


def test_verify_updates_timestamp_and_adds_sample(client, db, h, sshd):
    _, r = _onboard(client, h, sshd)
    sid = r.json()["server"]["id"]
    before = client.get(f"{API}/servers/{sid}").json()["lastCheckedAt"]
    v = client.post(f"{API}/servers/{sid}/verify", headers=h)
    assert v.status_code == 200 and v.json()["lastCheckedAt"] >= before
    assert db.execute(text("SELECT count(*) FROM server_metric_samples")).scalar() == 2


def test_add_fails_when_service_key_not_authorized_and_creates_nothing(client, db, h, sshd):
    _, r = _onboard(client, h, sshd, authorize=False)
    assert r.status_code == 422 and r.json()["code"] == "auth_failed" and "authorized_keys" in r.json()["message"]
    assert db.execute(text("SELECT count(*) FROM servers")).scalar() == 0
    assert "PRIVATE KEY" not in r.text


def test_fingerprint_mismatch_blocks_connection(client, db, h, sshd):
    client.get(f"{API}/servers/public-key")
    r = client.post(f"{API}/servers", headers=h, json={
        "name": "x", "host": "127.0.0.1", "port": sshd.port, "username": "servermind", "fingerprint": "SHA256:" + "A" * 43})
    assert r.status_code == 409 and r.json()["code"] == "host_key_changed"
    assert db.execute(text("SELECT count(*) FROM servers")).scalar() == 0
    assert sshd.commands == []  # к серверу даже не выполнялся вход
    assert db.execute(text("SELECT count(*) FROM audit_events WHERE action='server.fingerprint_mismatch'")).scalar() == 1


def test_host_key_change_after_pinning_is_detected_on_verify(client, db, h, sshd):
    _, r = _onboard(client, h, sshd)
    sid = r.json()["server"]["id"]
    sshd.restart_with_new_host_key()  # тот же порт, другой ключ — «подмена сервера»
    sshd.commands.clear()
    v = client.post(f"{API}/servers/{sid}/verify", headers=h)
    assert v.status_code == 409 and v.json()["code"] == "host_key_changed"
    assert sshd.commands == []  # команды НЕ выполнялись
    assert client.get(f"{API}/servers/{sid}").json()["status"] == "offline"
    assert db.execute(text("SELECT count(*) FROM audit_events WHERE action='server.host_key_changed'")).scalar() == 1


def test_unreachable_server_gives_actionable_error(client, h, sshd):
    port = sshd.port
    sshd.stop()
    r = client.post(f"{API}/servers/probe", json={"host": "127.0.0.1", "port": port}, headers=h)
    assert r.status_code == 502 and r.json()["code"] == "unreachable"


def test_offline_server_keeps_last_known_data_and_marks_offline(client, db, h, sshd):
    _, r = _onboard(client, h, sshd)
    sid = r.json()["server"]["id"]
    sshd.stop()
    v = client.post(f"{API}/servers/{sid}/verify", headers=h)
    assert v.status_code in (502, 504)
    s = client.get(f"{API}/servers/{sid}").json()
    assert s["status"] == "offline" and s["lastSuccessAt"] and s["cpuPercent"] == 50.0  # последние известные данные


def test_duplicate_server_conflict(client, h, sshd):
    _onboard(client, h, sshd)
    _, r = _onboard(client, h, sshd)
    assert r.status_code == 409 and r.json()["code"] == "duplicate"


def test_root_user_is_rejected(client, h, sshd):
    _, r = _onboard(client, h, sshd, username="root")
    assert r.status_code == 422 and r.json()["code"] == "username"


def test_private_targets_blocked_by_default_policy(client, h, monkeypatch):
    set_env(monkeypatch, allow_private_targets="false")
    for host in ("127.0.0.1", "10.0.0.5", "169.254.169.254", "localhost", "192.168.1.10"):
        r = client.post(f"{API}/servers/probe", json={"host": host, "port": 22}, headers=h)
        assert r.status_code == 422 and r.json()["code"] == "host_policy", host


def test_ssh_operations_are_rate_limited(client, h, monkeypatch):
    set_env(monkeypatch, ssh_ops_per_minute="2", allow_private_targets="false")
    codes = [client.post(f"{API}/servers/probe", json={"host": "10.0.0.1", "port": 22}, headers=h).status_code for _ in range(1)]
    assert codes == [422]  # политика отклоняет до расхода лимита
    set_env(monkeypatch, ssh_ops_per_minute="2", allow_private_targets="true")
    c = [client.post(f"{API}/servers/probe", json={"host": "127.0.0.1", "port": 1025}, headers=h).status_code for _ in range(3)]
    assert c[:2] == [502, 502] and c[2] == 429


# ───────── изоляция арендаторов (IDOR) и роли ─────────
def test_tenant_isolation_idor(client, db, h, sshd):
    _, r = _onboard(client, h, sshd)
    sid = r.json()["server"]["id"]
    other = make_user(db, "mallory@example.com", role="owner")
    h2 = login_full(client, db, other)
    assert client.get(f"{API}/servers").json() == []
    for method, path in [("get", f"/servers/{sid}"), ("post", f"/servers/{sid}/verify"), ("get", f"/servers/{sid}/metrics"),
                         ("get", f"/servers/{sid}/services")]:
        resp = getattr(client, method)(API + path, headers=h2)
        assert resp.status_code == 404, path  # не 403: существование чужого ресурса не раскрывается


def test_tenant_keys_are_separate_per_organization(client, db, h, owner):
    k1 = client.get(f"{API}/servers/public-key").json()["key"]
    other = make_user(db, "other@example.com", role="owner")
    login_full(client, db, other)
    assert client.get(f"{API}/servers/public-key").json()["key"] != k1


def test_organization_id_in_request_is_ignored(client, db, h, sshd):
    _, r = _onboard(client, h, sshd)
    other = make_user(db, "eve@example.com", role="owner")
    h2 = login_full(client, db, other)
    probe = client.post(f"{API}/servers/probe", headers=h2, json={"host": "127.0.0.1", "port": sshd.port, "organization_id": str(other.org_id)})
    assert probe.status_code == 200  # лишнее поле не влияет на tenant — организация берётся из сессии
    assert client.get(f"{API}/servers", headers=h2).json() == []


def test_viewer_can_read_but_not_add_or_verify(client, db, owner, sshd):
    h = login_full(client, db, owner)
    _, r = _onboard(client, h, sshd)
    sid = r.json()["server"]["id"]
    viewer = make_user(db, "viewer@example.com", role="viewer", org_id=owner.org_id, totp=False)
    client.cookies.clear()
    lr = client.post(f"{API}/auth/login", json={"email": viewer.email, "password": "correct-horse-battery-staple"})
    hv = {"X-CSRF-Token": lr.json()["csrfToken"]}
    assert client.get(f"{API}/servers").status_code == 200
    assert client.get(f"{API}/servers/{sid}").status_code == 200
    assert client.post(f"{API}/servers/probe", json={"host": "127.0.0.1", "port": sshd.port}, headers=hv).status_code == 403
    assert client.post(f"{API}/servers/{sid}/verify", headers=hv).status_code == 403
    assert client.post(f"{API}/servers", headers=hv, json={"host": "127.0.0.1", "port": sshd.port, "username": "x", "fingerprint": "SHA256:" + "A" * 43}).status_code == 403


def test_malformed_server_id_is_404(client, h):
    assert client.get(f"{API}/servers/not-a-uuid").status_code == 404


def test_responses_never_contain_private_key_material(client, db, h, sshd):
    _, r = _onboard(client, h, sshd)
    for resp in (r, client.get(f"{API}/servers"), client.get(f"{API}/servers/public-key")):
        assert "PRIVATE KEY" not in resp.text and "openssh-key-v1" not in resp.text
    dump = " ".join(str(x) for x in db.execute(text("SELECT meta::text, target FROM audit_events")).all())
    assert "PRIVATE KEY" not in dump
