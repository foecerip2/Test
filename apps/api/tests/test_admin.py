"""Админ-эндпоинты (только owner)."""

from __future__ import annotations

from tests.conftest import OWNER, Ctx

USER = "alice@example.com"


def _setup(ctx: Ctx):  # type: ignore[no-untyped-def]
    owner = ctx.new_client()
    ctx.login(OWNER, client=owner)
    user = ctx.new_client()
    ctx.login(USER, client=user)
    return owner, user


def test_admin_requires_owner(ctx: Ctx) -> None:
    owner, user = _setup(ctx)
    assert ctx.client.get("/api/v1/admin/users").status_code == 401
    assert user.get("/api/v1/admin/users").status_code == 403
    r = owner.get("/api/v1/admin/users")
    assert r.status_code == 200
    emails = {u["email"]: u for u in r.json()["users"]}
    assert emails[OWNER]["role"] == "owner" and emails[USER]["status"] == "pending"


def test_approve_makes_user_active(ctx: Ctx) -> None:
    owner, user = _setup(ctx)
    uid = str(ctx.user(USER).id)
    assert user.get("/api/v1/ping").status_code == 403
    r = owner.post(f"/api/v1/admin/users/{uid}/approve", headers=ctx.csrf(owner))
    assert r.status_code == 200 and r.json()["user"]["status"] == "active"
    assert user.get("/api/v1/ping").status_code == 200
    assert user.get("/api/v1/auth/me").json()["user"]["status"] == "active"


def test_admin_mutations_need_csrf(ctx: Ctx) -> None:
    owner, _ = _setup(ctx)
    uid = str(ctx.user(USER).id)
    r = owner.post(f"/api/v1/admin/users/{uid}/approve")
    assert r.status_code == 403 and r.json()["code"] == "CSRF_FAILED"
    assert ctx.user(USER).status == "pending"


def test_non_owner_cannot_approve(ctx: Ctx) -> None:
    _, user = _setup(ctx)
    uid = str(ctx.user(USER).id)
    r = user.post(f"/api/v1/admin/users/{uid}/approve", headers=ctx.csrf(user))
    assert r.status_code == 403


def test_block_revokes_sessions(ctx: Ctx) -> None:
    owner, user = _setup(ctx)
    uid = str(ctx.user(USER).id)
    owner.post(f"/api/v1/admin/users/{uid}/approve", headers=ctx.csrf(owner))
    assert user.get("/api/v1/ping").status_code == 200
    r = owner.post(f"/api/v1/admin/users/{uid}/block", headers=ctx.csrf(owner))
    assert r.status_code == 200 and r.json()["user"]["status"] == "blocked"
    assert user.get("/api/v1/auth/me").status_code == 401


def test_cannot_block_self(ctx: Ctx) -> None:
    owner, _ = _setup(ctx)
    oid = str(ctx.user(OWNER).id)
    r = owner.post(f"/api/v1/admin/users/{oid}/block", headers=ctx.csrf(owner))
    assert r.status_code == 400 and r.json()["code"] == "CANNOT_BLOCK_SELF"
    assert owner.get("/api/v1/auth/me").status_code == 200


def test_unknown_user_404(ctx: Ctx) -> None:
    owner, _ = _setup(ctx)
    r = owner.post(
        "/api/v1/admin/users/11111111-1111-4111-8111-111111111111/approve", headers=ctx.csrf(owner)
    )
    assert r.status_code == 404
