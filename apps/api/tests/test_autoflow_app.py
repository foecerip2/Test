"""AutoFlow: изоляция сессий, закрытый доступ и настоящие записи в БД."""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import select

from app.autoflow_models import Appointment, AutoFlowAccount
from app.models import User
from tests.conftest import OWNER, Ctx

AF = "https://autoflow.example.com"
BASE = "/api/v1/autoflow"


def login(ctx: Ctx, email: str = OWNER) -> None:
    ctx.clock.advance(120)
    r = ctx.client.post(BASE + "/auth/otp/request", json={"email": email}, headers={"Origin": AF})
    assert r.status_code == 202, r.text
    v = ctx.client.post(
        BASE + "/auth/otp/verify",
        json={"challenge_id": r.json()["challenge_id"], "code": ctx.mailer.code},
        headers={"Origin": AF},
    )
    assert v.status_code == 200, v.text
    assert ctx.client.cookies.get("af_session")


def headers(ctx: Ctx) -> dict[str, str]:
    return {"Origin": AF, "X-CSRF-Token": ctx.client.cookies.get("af_csrf") or ""}


def post(ctx: Ctx, path: str, body: dict[str, Any]) -> Any:
    return ctx.client.post(BASE + "/app" + path, json=body, headers=headers(ctx))


def setup(ctx: Ctx) -> dict[str, Any]:
    login(ctx)
    r = ctx.client.put(
        BASE + "/app/workspace",
        json={"name": "Тест Сервис", "city": "Казань", "opens": 540, "closes": 1080},
        headers=headers(ctx),
    )
    assert r.status_code == 200, r.text
    service = post(ctx, "/services", {"name": "Диагностика", "duration": 60, "price": 1200})
    resource = post(ctx, "/resources", {"name": "Бокс 1"})
    assert service.status_code == resource.status_code == 201
    return {
        "service_id": service.json()["id"],
        "resource_id": resource.json()["id"],
        "day": "2026-11-11",
        "starts": 600,
        "customer": "Клиент",
        "phone": "+79991234567",
        "consent": True,
    }


@pytest.fixture
def ctx(make_ctx: Any) -> Ctx:
    return make_ctx(autoflow_origins=AF)


def test_autoflow_session_cannot_open_leadhunter_and_vice_versa(ctx: Ctx) -> None:
    login(ctx)
    assert ctx.client.get(BASE + "/account").status_code == 200
    assert ctx.client.get("/api/v1/auth/me").status_code == 401
    # Даже копирование токена в другое имя cookie не меняет контур сессии.
    ctx.client.cookies.set("lh_session", ctx.client.cookies.get("af_session"))
    assert ctx.client.get("/api/v1/auth/me").status_code == 401
    ctx.client.cookies.clear()
    ctx.login(OWNER)
    ctx.client.cookies.set("af_session", ctx.client.cookies.get("lh_session"))
    assert ctx.client.get(BASE + "/account").status_code == 401


def test_challenges_cannot_be_verified_or_resent_in_another_product(ctx: Ctx) -> None:
    r = ctx.request_code(OWNER)
    body = {"challenge_id": r.json()["challenge_id"], "code": ctx.mailer.code}
    assert ctx.client.post(BASE + "/auth/otp/verify", json=body).status_code == 410
    assert (
        ctx.client.post(
            BASE + "/auth/otp/resend", json={"challenge_id": body["challenge_id"]}
        ).status_code
        == 410
    )
    assert ctx.verify(body["challenge_id"], body["code"]).status_code == 200


def test_origin_is_allowed_only_for_autoflow_routes(ctx: Ctx) -> None:
    assert (
        ctx.client.post(
            "/api/v1/auth/otp/request", json={"email": OWNER}, headers={"Origin": AF}
        ).status_code
        == 403
    )
    assert (
        ctx.client.post(
            BASE + "/auth/otp/request",
            json={"email": OWNER},
            headers={"Origin": "https://evil.example"},
        ).status_code
        == 403
    )
    login(ctx)
    assert (
        post(ctx, "/resources", {"name": "Бокс"}).status_code == 409
    )  # origin разрешён, нет настройки


def test_app_subdomain_allows_autoflow_auth_only(make_ctx: Any) -> None:
    ctx = make_ctx(autoflow_domain="autoflow.example.com")
    headers = {"Origin": "https://app.autoflow.example.com"}
    response = ctx.client.post(BASE + "/auth/otp/request", json={"email": OWNER}, headers=headers)
    assert response.status_code == 202
    response = ctx.client.post("/api/v1/auth/otp/request", json={"email": OWNER}, headers=headers)
    assert response.status_code == 403
    response = ctx.client.post(
        BASE + "/auth/otp/request", json={"email": OWNER},
        headers={"Origin": "https://evil.autoflow.example.com"},
    )
    assert response.status_code == 403


def test_registration_saves_profile_but_never_grants_access(ctx: Ctx) -> None:
    login(ctx, "new@example.com")
    r = ctx.client.put(
        BASE + "/account",
        json={"name": "Иван", "business_name": "Сервис", "city": "Уфа", "consent": True},
        headers=headers(ctx),
    )
    assert r.status_code == 200
    assert r.json()["access"] == "waiting"
    with ctx.db() as db:
        assert db.scalar(select(AutoFlowAccount)).business_name == "Сервис"
    for path in ("/state?day=2026-11-11",):
        assert ctx.client.get(BASE + "/app" + path).status_code == 403
    assert post(ctx, "/services", {"name": "Подмена", "duration": 60}).status_code == 403
    assert post(ctx, "/resources", {"name": "Бокс"}).status_code == 403


def test_even_active_non_admin_cannot_open_app(ctx: Ctx) -> None:
    login(ctx, "active@example.com")
    with ctx.db() as db:
        user = db.scalar(select(User).where(User.email == "active@example.com"))
        user.status = "active"
        db.commit()
    assert ctx.client.get(BASE + "/app/state?day=2026-11-11").status_code == 403
    assert ctx.client.get(BASE + "/account").json()["access"] == "waiting"


def test_mutations_require_csrf_and_consent(ctx: Ctx) -> None:
    login(ctx)
    r = ctx.client.put(
        BASE + "/account",
        json={"name": "Иван", "business_name": "Сервис", "city": "Уфа", "consent": True},
    )
    assert r.status_code == 403
    r = ctx.client.put(
        BASE + "/account",
        json={"name": "Иван", "business_name": "Сервис", "city": "Уфа", "consent": False},
        headers=headers(ctx),
    )
    assert r.status_code == 422
    assert (
        ctx.client.put(
            BASE + "/app/workspace",
            json={"name": "Сервис", "city": "Уфа"},
            headers={"X-CSRF-Token": "wrong"},
        ).status_code
        == 403
    )


def test_real_booking_lifecycle_and_no_overlap(ctx: Ctx) -> None:
    body = setup(ctx)
    first = post(ctx, "/appointments", body)
    assert first.status_code == 201, first.text
    assert post(ctx, "/appointments", {**body, "starts": 630}).status_code == 409
    assert (
        post(ctx, "/appointments", {**body, "starts": 660}).status_code == 201
    )  # граница свободна
    state = ctx.client.get(BASE + "/app/state?day=2026-11-11").json()
    assert len(state["appointments"]) == 2
    with ctx.db() as db:
        assert len(list(db.scalars(select(Appointment)))) == 2
    url = BASE + "/app/appointments/" + first.json()["id"]
    assert (
        ctx.client.patch(url, json={"status": "cancelled"}, headers=headers(ctx)).status_code == 200
    )
    assert post(ctx, "/appointments", body).status_code == 201
    assert (
        ctx.client.patch(url, json={"status": "confirmed"}, headers=headers(ctx)).status_code == 409
    )


@pytest.mark.parametrize(
    "patch",
    [
        {"starts": 530},
        {"starts": 1070},
        {"starts": 601},
        {"day": "2026-11-09"},
        {"consent": False},
        {"phone": "javascript:bad"},
    ],
)
def test_invalid_booking_never_written(ctx: Ctx, patch: dict[str, Any]) -> None:
    body = setup(ctx)
    assert post(ctx, "/appointments", {**body, **patch}).status_code == 422
    with ctx.db() as db:
        assert db.scalar(select(Appointment)) is None


def test_ownership_isolation(ctx: Ctx) -> None:
    body = setup(ctx)
    original = post(ctx, "/appointments", body).json()["id"]
    other = "other-owner@example.com"
    ctx.client.cookies.clear()
    login(ctx, other)
    with ctx.db() as db:
        user = db.scalar(select(User).where(User.email == other))
        user.role, user.status = "owner", "active"
        db.commit()
    state = ctx.client.get(BASE + "/app/state?day=2026-11-11").json()
    assert state["workspace"] is None
    assert (
        ctx.client.put(
            BASE + "/app/workspace", json={"name": "Другой", "city": "Уфа"}, headers=headers(ctx)
        ).status_code
        == 200
    )
    assert post(ctx, "/appointments", body).status_code == 404
    assert (
        ctx.client.patch(
            BASE + "/app/appointments/" + original,
            json={"status": "cancelled"},
            headers=headers(ctx),
        ).status_code
        == 404
    )
    assert ctx.client.get(BASE + "/app/state?day=2026-11-11").json()["services"] == []


def test_logout_revokes_autoflow_session_only(ctx: Ctx) -> None:
    login(ctx)
    ctx.login(OWNER)
    assert ctx.client.post(BASE + "/auth/logout", headers=headers(ctx)).status_code == 204
    assert ctx.client.get(BASE + "/account").status_code == 401
    assert ctx.client.get("/api/v1/auth/me").status_code == 200


def test_autoflow_registration_is_not_a_leadhunter_membership(ctx: Ctx) -> None:
    email = "only-autoflow@example.com"
    login(ctx, email)
    with ctx.db() as db:
        user = db.scalar(select(User).where(User.email == email))
        assert user is not None and not user.leadhunter_member
        af_uid = str(user.id)
    ctx.login(OWNER)
    users = ctx.client.get("/api/v1/admin/users").json()["users"]
    assert email not in [u["email"] for u in users]
    assert (
        ctx.client.post(f"/api/v1/admin/users/{af_uid}/approve", headers=ctx.csrf()).status_code
        == 404
    )
    # Участие в LeadHunter появляется только после явного подтверждённого входа в него.
    ctx.login(email, client=ctx.new_client())
    users = ctx.client.get("/api/v1/admin/users").json()["users"]
    assert next(u for u in users if u["email"] == email)["status"] == "pending"


def test_pilot_inbox_uses_autoflow_session_and_admin_permissions(ctx: Ctx) -> None:
    r = ctx.client.post(
        BASE + "/pilot-requests",
        json={
            "business_name": "Пилот Сервис",
            "city": "Казань",
            "contact_name": "Иван",
            "email": "pilot@example.com",
            "consent": True,
        },
        headers={"Origin": AF},
    )
    assert r.status_code == 202
    login(ctx)
    listing = ctx.client.get(BASE + "/app/pilots")
    assert listing.status_code == 200, listing.text
    row = listing.json()["items"][0]
    assert row["business_name"] == "Пилот Сервис"
    url = BASE + "/app/pilots/" + row["id"]
    assert ctx.client.patch(url, json={"status": "contacted"}).status_code == 403
    updated = ctx.client.patch(
        url, json={"status": "contacted", "note": "Обсудили пилот"}, headers=headers(ctx)
    )
    assert updated.status_code == 200
    assert updated.json()["note"] == "Обсудили пилот"
    assert ctx.client.get(BASE + "/app/pilots?status=wrong").status_code == 422
    ctx.client.cookies.clear()
    login(ctx, "visitor@example.com")
    assert ctx.client.get(BASE + "/app/pilots").status_code == 403
    assert (
        ctx.client.patch(url, json={"status": "accepted"}, headers=headers(ctx)).status_code == 403
    )


def test_moscow_timezone_available_without_os_zoneinfo() -> None:
    # Slim Docker может не содержать /usr/share/zoneinfo: нужен пакет tzdata.
    import subprocess
    import sys

    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "from zoneinfo import ZoneInfo,reset_tzpath; from datetime import datetime; reset_tzpath([]); print(datetime(2026,11,12,tzinfo=ZoneInfo('Europe/Moscow')).utcoffset())",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout.strip() == "3:00:00"
