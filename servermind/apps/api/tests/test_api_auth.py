import datetime as dt

import pyotp
import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app.core.security import hash_token
from tests.conftest import PASSWORD, login_full, make_user, set_env

API = "/api/v1"


def test_healthz_and_readyz(client):
    assert client.get("/healthz").json() == {"status": "ok"}
    assert client.get("/readyz").json() == {"status": "ready"}  # реальная проверка PostgreSQL


def test_unauthenticated_requests_are_rejected(client):
    for method, path in [("get", "/me"), ("get", "/servers"), ("post", "/servers/probe"), ("get", "/servers/public-key")]:
        r = getattr(client, method)(API + path)
        assert r.status_code == 401, path


def test_login_failure_is_generic_for_unknown_user_and_wrong_password(client, owner):
    a = client.post(f"{API}/auth/login", json={"email": "ghost@example.com", "password": "whatever-123"})
    b = client.post(f"{API}/auth/login", json={"email": owner.email, "password": "wrong-password-1"})
    assert a.status_code == b.status_code == 401
    assert a.json() == b.json()  # не раскрываем, существует ли email


def test_login_rate_limit_blocks_even_correct_password(client, owner, monkeypatch):
    set_env(monkeypatch, login_max_failures="3")
    for _ in range(3):
        assert client.post(f"{API}/auth/login", json={"email": owner.email, "password": "bad-password-1"}).status_code == 401
    r = client.post(f"{API}/auth/login", json={"email": owner.email, "password": PASSWORD})
    assert r.status_code == 429 and r.json()["code"] == "rate_limited"


def test_session_cookie_is_httponly_and_token_stored_hashed(client, db, owner):
    r = client.post(f"{API}/auth/login", json={"email": owner.email, "password": PASSWORD})
    sc = r.headers["set-cookie"].lower()
    assert "httponly" in sc and "samesite=lax" in sc
    token = client.cookies.get("sm_session")
    assert token
    rows = db.execute(text("SELECT token_hash FROM sessions")).scalars().all()
    assert rows == [hash_token(token)] and token not in rows


def test_2fa_required_before_access_and_session_rotated(client, db, owner):
    r = client.post(f"{API}/auth/login", json={"email": owner.email, "password": PASSWORD})
    assert r.json()["twoFactorRequired"] is True
    csrf = r.json()["csrfToken"]
    first_cookie = client.cookies.get("sm_session")
    assert client.get(f"{API}/servers").status_code == 403
    assert client.get(f"{API}/servers").json()["code"] == "two_factor_required"
    bad = client.post(f"{API}/auth/2fa", json={"code": "000000"}, headers={"X-CSRF-Token": csrf})
    assert bad.status_code == 401
    ok = client.post(f"{API}/auth/2fa", json={"code": pyotp.TOTP(owner.totp_secret).now()}, headers={"X-CSRF-Token": csrf})
    assert ok.status_code == 200
    assert client.cookies.get("sm_session") != first_cookie  # ротация токена при повышении привилегий
    assert client.get(f"{API}/servers").status_code == 200


def test_old_session_token_invalid_after_rotation(client, db, owner):
    client.post(f"{API}/auth/login", json={"email": owner.email, "password": PASSWORD})
    old = client.cookies.get("sm_session")
    csrf = client.get(f"{API}/me").json()["csrfToken"]
    client.post(f"{API}/auth/2fa", json={"code": pyotp.TOTP(owner.totp_secret).now()}, headers={"X-CSRF-Token": csrf})
    client.cookies.clear()
    client.cookies.set("sm_session", old)
    assert client.get(f"{API}/me").status_code == 401


def test_totp_code_cannot_be_replayed(client, db, owner):
    code = pyotp.TOTP(owner.totp_secret).now()
    r = client.post(f"{API}/auth/login", json={"email": owner.email, "password": PASSWORD})
    assert client.post(f"{API}/auth/2fa", json={"code": code}, headers={"X-CSRF-Token": r.json()["csrfToken"]}).status_code == 200
    client.cookies.clear()
    r = client.post(f"{API}/auth/login", json={"email": owner.email, "password": PASSWORD})
    again = client.post(f"{API}/auth/2fa", json={"code": code}, headers={"X-CSRF-Token": r.json()["csrfToken"]})
    assert again.status_code == 401  # тот же код второй раз не принимается


def test_privileged_role_without_2fa_must_enroll(client, db):
    u = make_user(db, "newowner@example.com", role="owner", totp=False)
    r = client.post(f"{API}/auth/login", json={"email": u.email, "password": PASSWORD})
    assert r.json()["twoFactorSetupRequired"] is True
    csrf = r.json()["csrfToken"]
    blocked = client.get(f"{API}/servers")
    assert blocked.status_code == 403 and blocked.json()["code"] == "two_factor_setup_required"
    setup = client.post(f"{API}/auth/2fa/setup", headers={"X-CSRF-Token": csrf})
    assert setup.status_code == 200
    secret = setup.json()["secret"]
    assert setup.json()["otpauthUri"].startswith("otpauth://totp/")
    # секрет в БД лежит только зашифрованным
    stored = db.execute(text("SELECT totp_secret_enc FROM users WHERE id=:i"), {"i": u.id}).scalar()
    assert secret.encode() not in bytes(stored)
    assert client.post(f"{API}/auth/2fa/enable", json={"code": "123456"}, headers={"X-CSRF-Token": csrf}).status_code == 401
    en = client.post(f"{API}/auth/2fa/enable", json={"code": pyotp.TOTP(secret).now()}, headers={"X-CSRF-Token": csrf})
    assert en.status_code == 200
    assert client.get(f"{API}/servers").status_code == 200


def test_viewer_does_not_require_2fa(client, db):
    u = make_user(db, "viewer@example.com", role="viewer", totp=False)
    r = client.post(f"{API}/auth/login", json={"email": u.email, "password": PASSWORD})
    assert r.json() == {"twoFactorRequired": False, "twoFactorSetupRequired": False, "csrfToken": r.json()["csrfToken"]}
    assert client.get(f"{API}/servers").status_code == 200


def test_csrf_required_for_mutations(client, db, owner):
    h = login_full(client, db, owner)
    assert client.post(f"{API}/servers/probe", json={"host": "127.0.0.1", "port": 22}).json()["code"] == "csrf"
    assert client.post(f"{API}/servers/probe", json={"host": "127.0.0.1", "port": 22}, headers={"X-CSRF-Token": "x" * 43}).status_code == 403
    assert client.get(f"{API}/servers").status_code == 200  # безопасные методы CSRF не требуют
    assert h["X-CSRF-Token"]


def test_session_idle_and_absolute_expiry(client, db, owner):
    login_full(client, db, owner)
    db.execute(text("UPDATE sessions SET last_seen_at = now() - interval '13 hours'"))
    db.commit()
    r = client.get(f"{API}/me")
    assert r.status_code == 401 and r.json()["code"] == "session_expired"
    assert db.execute(text("SELECT count(*) FROM sessions")).scalar() == 0  # просроченная сессия удалена
    login_full(client, db, owner)
    db.execute(text("UPDATE sessions SET expires_at = now() - interval '1 second'"))
    db.commit()
    assert client.get(f"{API}/me").status_code == 401


def test_logout_destroys_session(client, db, owner):
    h = login_full(client, db, owner)
    assert client.post(f"{API}/auth/logout", headers=h).status_code == 200
    assert client.get(f"{API}/me").status_code == 401
    assert db.execute(text("SELECT count(*) FROM sessions")).scalar() == 0


def test_me_has_no_secrets(client, db, owner):
    login_full(client, db, owner)
    body = client.get(f"{API}/me").text.lower()
    for needle in ("password", "argon2", "totp_secret", owner.totp_secret.lower()):
        assert needle not in body


def test_audit_trail_has_no_credentials_and_is_append_only(client, db, owner):
    client.post(f"{API}/auth/login", json={"email": owner.email, "password": "bad-password-1"})
    login_full(client, db, owner)
    rows = db.execute(text("SELECT action, meta::text, target FROM audit_events")).all()
    actions = {r[0] for r in rows}
    assert {"auth.login_failed", "auth.login", "auth.2fa_ok"} <= actions
    dump = " ".join(f"{r[1]} {r[2]}" for r in rows)
    assert PASSWORD not in dump and "bad-password-1" not in dump
    with pytest.raises(DBAPIError):
        db.execute(text("UPDATE audit_events SET action='tampered'"))
    db.rollback()
    with pytest.raises(DBAPIError):
        db.execute(text("DELETE FROM audit_events"))
    db.rollback()


def test_validation_errors_do_not_echo_input(client):
    r = client.post(f"{API}/auth/login", json={"email": "a@b.co", "password": ""})
    assert r.status_code == 422 and "password" in r.json()["message"]
    assert "a@b.co" not in r.text


def test_expired_timestamps_helper_sanity():
    assert dt.datetime.now(dt.UTC).tzinfo is not None
