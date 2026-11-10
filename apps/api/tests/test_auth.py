"""Поток входа по одноразовому коду."""

from __future__ import annotations

import logging
from collections.abc import Callable

from sqlalchemy import select

from app.models import OtpChallenge, SessionRow
from tests.conftest import OWNER, Ctx

USER = "alice@example.com"


def test_full_flow(ctx: Ctx) -> None:
    r = ctx.request_code(OWNER)
    assert r.status_code == 202
    body = r.json()
    assert body["expires_in"] == 600 and body["resend_in"] == 60
    assert len(ctx.mailer.sent) == 1 and ctx.mailer.sent[0]["to"] == OWNER

    v = ctx.verify(body["challenge_id"], ctx.mailer.code)
    assert v.status_code == 200
    data = v.json()
    assert data["is_new"] is True
    assert data["user"]["email"] == OWNER and data["user"]["role"] == "owner"
    assert data["user"]["status"] == "active"

    me = ctx.client.get("/api/v1/auth/me")
    assert me.status_code == 200 and me.json()["user"]["email"] == OWNER

    out = ctx.client.post("/api/v1/auth/logout", headers=ctx.csrf())
    assert out.status_code == 204
    assert ctx.client.get("/api/v1/auth/me").status_code == 401


def test_email_is_normalized(ctx: Ctx) -> None:
    r = ctx.request_code("  Alice@Example.COM ")
    assert r.status_code == 202
    assert ctx.mailer.sent[0]["to"] == USER
    v = ctx.verify(r.json()["challenge_id"], ctx.mailer.code)
    assert v.json()["user"]["email"] == USER


def test_invalid_email_rejected(ctx: Ctx) -> None:
    r = ctx.request_code("not-an-email")
    assert r.status_code == 422
    assert r.json()["code"] == "VALIDATION_ERROR"
    assert ctx.mailer.sent == []


def test_wrong_code_reports_attempts_left(ctx: Ctx) -> None:
    cid = ctx.request_code(USER).json()["challenge_id"]
    wrong = "000000" if ctx.mailer.code != "000000" else "111111"
    r = ctx.verify(cid, wrong)
    assert r.status_code == 400
    assert r.json()["code"] == "INVALID_CODE" and r.json()["attempts_left"] == 4
    assert ctx.verify(cid, "abc").json()["attempts_left"] == 3  # нецифровой ввод тоже попытка


def test_attempt_limit_locks_challenge(ctx: Ctx) -> None:
    cid = ctx.request_code(USER).json()["challenge_id"]
    good = ctx.mailer.code
    wrong = "000000" if good != "000000" else "111111"
    for left in (4, 3, 2, 1, 0):
        assert ctx.verify(cid, wrong).json()["attempts_left"] == left
    locked = ctx.verify(cid, good)  # даже верный код после лимита не принимается
    assert locked.status_code == 429 and locked.json()["code"] == "TOO_MANY_ATTEMPTS"
    assert ctx.client.post("/api/v1/auth/otp/resend", json={"challenge_id": cid}).status_code == 429


def test_expired_code(ctx: Ctx) -> None:
    cid = ctx.request_code(USER).json()["challenge_id"]
    ctx.clock.advance(601)
    r = ctx.verify(cid, ctx.mailer.code)
    assert r.status_code == 410 and r.json()["code"] == "CODE_EXPIRED"


def test_code_valid_just_before_expiry(ctx: Ctx) -> None:
    cid = ctx.request_code(USER).json()["challenge_id"]
    ctx.clock.advance(599)
    assert ctx.verify(cid, ctx.mailer.code).status_code == 200


def test_code_is_single_use(ctx: Ctx) -> None:
    cid = ctx.request_code(USER).json()["challenge_id"]
    code = ctx.mailer.code
    assert ctx.verify(cid, code).status_code == 200
    again = ctx.verify(cid, code)
    assert again.status_code == 410 and again.json()["code"] == "CODE_USED"


def test_unknown_challenge(ctx: Ctx) -> None:
    r = ctx.verify("11111111-1111-4111-8111-111111111111", "123456")
    assert r.status_code == 410


def test_resend_cooldown(ctx: Ctx) -> None:
    cid = ctx.request_code(USER).json()["challenge_id"]
    r = ctx.client.post("/api/v1/auth/otp/resend", json={"challenge_id": cid})
    assert r.status_code == 429 and r.json()["code"] == "RATE_LIMITED"
    assert int(r.headers["Retry-After"]) >= 1
    assert len(ctx.mailer.sent) == 1


def test_resend_invalidates_old_code(ctx: Ctx) -> None:
    cid = ctx.request_code(USER).json()["challenge_id"]
    old = ctx.mailer.code
    ctx.clock.advance(61)
    r = ctx.client.post("/api/v1/auth/otp/resend", json={"challenge_id": cid})
    assert r.status_code == 202 and r.json() == {"resend_in": 60}
    new = ctx.mailer.code
    assert len(ctx.mailer.sent) == 2
    if old != new:  # шанс совпадения 1e-6
        assert ctx.verify(cid, old).status_code == 400
    assert ctx.verify(cid, new).status_code == 200


def test_resend_total_sends_limit(ctx: Ctx) -> None:
    cid = ctx.request_code(USER).json()["challenge_id"]
    with ctx.db() as db:
        ch = db.scalar(select(OtpChallenge))
        assert ch is not None
        ch.sends = 5
        db.commit()
    ctx.clock.advance(61)
    r = ctx.client.post("/api/v1/auth/otp/resend", json={"challenge_id": cid})
    assert r.status_code == 429


def test_rate_limit_email_cooldown(ctx: Ctx) -> None:
    assert ctx.request_code(USER).status_code == 202
    r = ctx.request_code(USER)
    assert r.status_code == 429 and r.json()["code"] == "RATE_LIMITED"
    assert 1 <= int(r.headers["Retry-After"]) <= 60
    ctx.clock.advance(61)
    assert ctx.request_code(USER).status_code == 202


def test_rate_limit_email_per_hour(ctx: Ctx) -> None:
    for _ in range(5):
        assert ctx.request_code(USER).status_code == 202
        ctx.clock.advance(61)
    r = ctx.request_code(USER)
    assert r.status_code == 429
    assert int(r.headers["Retry-After"]) > 60
    ctx.clock.advance(3600)
    assert ctx.request_code(USER).status_code == 202


def test_rate_limit_per_ip(ctx: Ctx) -> None:
    for i in range(20):
        assert ctx.request_code(f"user{i}@example.com", ip="203.0.113.7").status_code == 202
    r = ctx.request_code("user99@example.com", ip="203.0.113.7")
    assert r.status_code == 429 and "Retry-After" in r.headers
    assert ctx.request_code("user99@example.com", ip="203.0.113.8").status_code == 202


def test_rate_limits_persist_in_db(make_ctx: Callable[..., Ctx]) -> None:
    c = make_ctx()
    assert c.request_code(USER).status_code == 202
    # «рестарт»: новое приложение на той же БД
    from app.main import create_app

    app2 = create_app(c.settings, c.mailer)
    from fastapi.testclient import TestClient

    with TestClient(app2, base_url="http://localhost:3000") as client2:
        r = client2.post("/api/v1/auth/otp/request", json={"email": USER})
        assert r.status_code == 429


def test_no_account_enumeration(ctx: Ctx) -> None:
    ctx.login(USER)  # аккаунт существует
    ctx.clock.advance(3700)
    fresh = ctx.new_client()
    existing = fresh.post("/api/v1/auth/otp/request", json={"email": USER})
    ctx.clock.advance(120)
    new = fresh.post("/api/v1/auth/otp/request", json={"email": "brand-new@example.com"})
    assert existing.status_code == new.status_code == 202
    assert set(existing.json()) == set(new.json())
    assert existing.json()["expires_in"] == new.json()["expires_in"]
    assert existing.json()["resend_in"] == new.json()["resend_in"]
    assert len(ctx.mailer.sent) == 3  # письмо уходит в обоих случаях


def test_owner_email_gets_owner_active(ctx: Ctx) -> None:
    v = ctx.login(OWNER.upper())
    assert v.json()["user"]["role"] == "owner" and v.json()["user"]["status"] == "active"


def test_other_users_are_pending(ctx: Ctx) -> None:
    v = ctx.login(USER)
    assert v.json()["user"]["role"] == "user" and v.json()["user"]["status"] == "pending"
    me = ctx.client.get("/api/v1/auth/me")
    assert me.status_code == 200 and me.json()["user"]["status"] == "pending"


def test_empty_owner_email_nobody_is_owner(make_ctx: Callable[..., Ctx]) -> None:
    c = make_ctx(owner_email="")
    for email in (OWNER, USER):
        v = c.login(email, client=c.new_client())
        assert v.json()["user"]["role"] == "user"
        assert v.json()["user"]["status"] == "pending"


def test_is_new_only_on_first_login(ctx: Ctx) -> None:
    assert ctx.login(USER).json()["is_new"] is True
    assert ctx.login(USER, client=ctx.new_client()).json()["is_new"] is False


def test_require_active_user(ctx: Ctx) -> None:
    assert ctx.client.get("/api/v1/ping").status_code == 401
    ctx.login(USER)
    r = ctx.client.get("/api/v1/ping")
    assert r.status_code == 403 and r.json()["code"] == "ACCOUNT_PENDING"
    owner_client = ctx.new_client()
    ctx.login(OWNER, client=owner_client)
    assert owner_client.get("/api/v1/ping").status_code == 200


def test_blocked_user_cannot_verify(ctx: Ctx) -> None:
    ctx.login(USER)
    with ctx.db() as db:
        u = ctx.user(USER)
        u.status = "blocked"
        db.merge(u)
        db.commit()
    ctx.clock.advance(120)
    cid = ctx.request_code(USER).json()["challenge_id"]
    r = ctx.verify(cid, ctx.mailer.code)
    assert r.status_code == 403 and r.json()["code"] == "ACCOUNT_BLOCKED"


def test_code_stored_only_as_hmac(ctx: Ctx) -> None:
    cid = ctx.request_code(USER).json()["challenge_id"]
    code = ctx.mailer.code
    with ctx.db() as db:
        ch = db.scalar(select(OtpChallenge))
        assert ch is not None and str(ch.id) == cid
        assert len(ch.code_hmac) == 64 and code not in ch.code_hmac
        assert ch.email == USER


def test_session_token_stored_hashed(ctx: Ctx) -> None:
    ctx.login(USER)
    token = ctx.client.cookies.get("lh_session")
    assert token
    with ctx.db() as db:
        rows = db.scalars(select(SessionRow)).all()
        assert len(rows) == 1 and rows[0].token_hash != token and token not in rows[0].token_hash


def test_code_and_email_not_in_logs(ctx: Ctx, caplog: object) -> None:
    import pytest

    assert isinstance(caplog, pytest.LogCaptureFixture)
    with caplog.at_level(logging.DEBUG):
        cid = ctx.request_code(USER).json()["challenge_id"]
        code = ctx.mailer.code
        ctx.verify(cid, "000000" if code != "000000" else "111111")
        ctx.verify(cid, code)
    assert code not in caplog.text
    assert USER not in caplog.text


def test_cookie_flags_secure_prod_like(make_ctx: Callable[..., Ctx]) -> None:
    c = make_ctx(cookie_secure=True)
    cid = c.request_code(USER).json()["challenge_id"]
    r = c.verify(cid, c.mailer.code)
    cookies = {h.split("=", 1)[0]: h for h in r.headers.get_list("set-cookie")}
    session = cookies["lh_session"].lower()
    assert "httponly" in session and "secure" in session
    assert "samesite=lax" in session and "path=/" in session and "max-age=2592000" in session
    csrf = cookies["lh_csrf"].lower()
    assert "httponly" not in csrf and "secure" in csrf and "samesite=lax" in csrf


def test_cookie_not_secure_in_dev_by_default(ctx: Ctx) -> None:
    cid = ctx.request_code(USER).json()["challenge_id"]
    r = ctx.verify(cid, ctx.mailer.code)
    assert all("secure" not in h.lower() for h in r.headers.get_list("set-cookie"))


def test_logout_requires_csrf(ctx: Ctx) -> None:
    ctx.login(USER)
    assert ctx.client.post("/api/v1/auth/logout").json()["code"] == "CSRF_FAILED"
    bad = ctx.client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": "wrong"})
    assert bad.status_code == 403
    assert ctx.client.get("/api/v1/auth/me").status_code == 200
    assert ctx.client.post("/api/v1/auth/logout", headers=ctx.csrf()).status_code == 204


def test_logout_revokes_session_server_side(ctx: Ctx) -> None:
    ctx.login(USER)
    token = ctx.client.cookies.get("lh_session")
    headers = ctx.csrf()
    ctx.client.post("/api/v1/auth/logout", headers=headers)
    replay = ctx.new_client()
    replay.cookies.set("lh_session", token or "")
    assert replay.get("/api/v1/auth/me").status_code == 401


def test_origin_check_on_mutations(ctx: Ctx) -> None:
    r = ctx.client.post(
        "/api/v1/auth/otp/request", json={"email": USER}, headers={"Origin": "https://evil.example"}
    )
    assert r.status_code == 403 and r.json()["code"] == "ORIGIN_FORBIDDEN"
    r = ctx.client.post(
        "/api/v1/auth/otp/request",
        json={"email": USER},
        headers={"Referer": "https://evil.example/x"},
    )
    assert r.status_code == 403
    ok = ctx.client.post(
        "/api/v1/auth/otp/request",
        json={"email": USER},
        headers={"Origin": "http://localhost:3000"},
    )
    assert ok.status_code == 202


def test_session_expires_after_30_days(ctx: Ctx) -> None:
    ctx.login(USER)
    ctx.clock.advance(29 * 86400)
    assert ctx.client.get("/api/v1/auth/me").status_code == 200
    ctx.clock.advance(2 * 86400)
    assert ctx.client.get("/api/v1/auth/me").status_code == 401


def test_mail_failure_returns_503_and_rolls_back(ctx: Ctx) -> None:
    ctx.mailer.fail = True
    r = ctx.request_code(USER)
    assert r.status_code == 503 and r.json()["code"] == "MAIL_UNAVAILABLE"
    assert "SMTP" not in r.text
    with ctx.db() as db:
        assert db.scalar(select(OtpChallenge)) is None
    ctx.mailer.fail = False
    assert ctx.request_code(USER).status_code == 202  # cooldown не «сгорел»


def test_error_format_and_security_headers(ctx: Ctx) -> None:
    r = ctx.client.get("/api/v1/auth/me")
    assert r.status_code == 401
    body = r.json()
    assert set(body) == {"code", "message", "request_id"} and body["request_id"]
    assert r.headers["X-Request-ID"] == body["request_id"]
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert r.headers["X-Frame-Options"] == "DENY"
    assert r.headers["Cache-Control"] == "no-store"
