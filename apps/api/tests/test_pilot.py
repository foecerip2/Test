"""Заявки на пилот AutoFlow: публичный приём, лимиты, дедупликация, CORS/Origin, кабинет владельца."""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app import security
from app.config import Settings
from app.models import AuditLog, PilotRequest, RateLimitEvent
from app.pilot_schemas import normalize_phone_ru
from tests.conftest import OWNER, Ctx
from tests.helpers import login_active_user, login_owner, login_pending

URL = "/api/v1/autoflow/pilot-requests"
SITE = "https://autoflow.example.com"
PHONE = "+7 (900) 123-45-67"
PHONE_NORM = "+79001234567"
EMAIL = "Ivan.Petrov@Example.com"
NAME = "Иван Петров"
BUSINESS = "Север Авто"


def body(**over: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "business_name": BUSINESS,
        "city": "Казань",
        "contact_name": NAME,
        "phone": PHONE,
        "email": None,
        "consent": True,
        "website": "",
    }
    data.update(over)
    return data


@pytest.fixture
def pctx(make_ctx: Callable[..., Ctx]) -> Ctx:
    return make_ctx(autoflow_origins=SITE)


def post(
    ctx: Ctx,
    data: Any = None,
    *,
    origin: str | None = SITE,
    ip: str = "203.0.113.5",
    client: TestClient | None = None,
    headers: dict[str, str] | None = None,
    raw: bytes | None = None,
    content_type: str = "application/json",
) -> Any:
    h: dict[str, str] = {"X-Forwarded-For": ip, "Content-Type": content_type}
    if origin is not None:
        h["Origin"] = origin
    h.update(headers or {})
    c = client or ctx.new_client()
    content = raw if raw is not None else json.dumps(body() if data is None else data).encode()
    return c.post(URL, content=content, headers=h)


def rows(ctx: Ctx) -> list[PilotRequest]:
    with ctx.db() as db:
        return list(db.scalars(select(PilotRequest).order_by(PilotRequest.created_at)))


def count_rows(ctx: Ctx) -> int:
    return len(rows(ctx))


def count_audit(ctx: Ctx, action: str) -> int:
    with ctx.db() as db:
        return (
            db.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.action == action))
            or 0
        )


# ------------------------------------------------------------------ успешный приём


def test_accepts_valid_request_and_stores_normalized(pctx: Ctx) -> None:
    r = post(pctx, body(email=EMAIL))
    assert r.status_code == 202 and r.json() == {"status": "accepted"}
    (row,) = rows(pctx)
    assert row.business_name == BUSINESS and row.city == "Казань" and row.contact_name == NAME
    assert row.phone == PHONE_NORM
    assert row.email == "ivan.petrov@example.com"
    assert row.status == "new" and row.note == ""
    assert row.consent_at == pctx.clock.now() and row.created_at == pctx.clock.now()
    assert row.consent_text_version == pctx.settings.pilot_consent_version


def test_email_only_and_phone_only_are_accepted(pctx: Ctx) -> None:
    assert post(pctx, body(phone=None, email="a@example.com")).status_code == 202
    assert post(pctx, body(phone=PHONE, email=None), ip="203.0.113.6").status_code == 202
    assert post(pctx, body(phone="", email="b@example.com"), ip="203.0.113.7").status_code == 202
    assert count_rows(pctx) == 3


def test_consent_version_from_client_is_stored(pctx: Ctx) -> None:
    assert post(pctx, body(consent_text_version="2026-11-v2")).status_code == 202
    assert rows(pctx)[0].consent_text_version == "2026-11-v2"
    r = post(pctx, body(consent_text_version="<script>"), ip="203.0.113.9")
    assert r.status_code == 422


def test_text_fields_are_cleaned(pctx: Ctx) -> None:
    r = post(pctx, body(business_name="  Север   Авто   ", city="Нижний\tНовгород"))
    assert r.status_code == 202
    row = rows(pctx)[0]
    assert row.business_name == "Север Авто" and row.city == "Нижний Новгород"


def test_unknown_fields_are_ignored(pctx: Ctx) -> None:
    assert post(pctx, body(role="owner", status="accepted", id="x")).status_code == 202
    assert rows(pctx)[0].status == "new"


def test_works_with_owner_cookies_and_without_csrf(pctx: Ctx) -> None:
    owner = login_owner(pctx)
    assert owner.cookies.get("lh_session")
    r = post(pctx, client=owner)  # сессия есть, CSRF-заголовка нет — и не нужен
    assert r.status_code == 202 and count_rows(pctx) == 1


def test_ip_hash_is_hmac_not_raw_ip(pctx: Ctx) -> None:
    post(pctx, ip="198.51.100.77")
    row = rows(pctx)[0]
    assert row.ip_hash is not None and len(row.ip_hash) == 64
    assert "198.51.100.77" not in row.ip_hash
    assert row.ip_hash == security.keyed_hash(pctx.settings, "pilot-ip", "198.51.100.77")
    post(pctx, body(phone="+79007654321"), ip="198.51.100.78")
    assert rows(pctx)[1].ip_hash != row.ip_hash


def test_user_agent_is_shortened_and_cleaned(pctx: Ctx) -> None:
    post(pctx, headers={"User-Agent": "Mozilla/5.0 " + "x" * 500})
    ua = rows(pctx)[0].user_agent_short
    assert ua is not None and len(ua) == 120 and ua.startswith("Mozilla/5.0 x")


def test_response_has_security_headers(pctx: Ctx) -> None:
    r = post(pctx)
    assert r.headers["cache-control"] == "no-store"
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-request-id"]


# ------------------------------------------------------------------ валидация


@pytest.mark.parametrize(
    "over",
    [
        {"business_name": ""},
        {"business_name": "   "},
        {"business_name": "x" * 121},
        {"business_name": "—— !!"},
        {"business_name": "Авто <b>1</b>"},
        {"business_name": "Авто​сервис"},  # zero-width
        {"business_name": "Авто‮сервис"},  # bidi
        {"business_name": "Авто\x00сервис"},
        {"business_name": 123},
        {"business_name": None},
        {"business_name": ["Авто"]},
        {"city": ""},
        {"city": "К" * 81},
        {"city": "https://spam.example"},
        {"city": "www.spam.ru"},
        {"city": None},
        {"contact_name": ""},
        {"contact_name": "И" * 81},
        {"contact_name": "http://x.ru"},
        {"contact_name": 5},
        {"consent": False},
        {"consent": None},
        {"consent": "true"},
        {"consent": 1},
        {"consent": "yes"},
        {"phone": None, "email": None},
        {"phone": "", "email": ""},
        {"phone": "   ", "email": "  "},
        {"phone": "123"},
        {"phone": "+1 202 555 0143"},
        {"phone": "+7 900 123-45"},
        {"phone": "+7 900 123-45-67-89"},
        {"phone": "abc"},
        {"phone": "+7 (900) 123-45-67 доб. 5"},
        {"phone": "+7 111 111 11 11"},
        {"phone": "+7 500 123 45 67"},  # не российский код
        {"phone": 89001234567},
        {"phone": "8" * 40},
        {"email": "not-an-email"},
        {"email": "a@b"},
        {"email": "a b@example.com"},
        {"email": "a@@example.com"},
        {"email": "@example.com"},
        {"email": "x" * 250 + "@example.com"},
        {"email": 5},
    ],
)
def test_invalid_input_is_422_and_not_stored(pctx: Ctx, over: dict[str, Any]) -> None:
    data = body(**over)
    if "email" in over and "phone" not in over:
        data["phone"] = None  # чтобы валидность контакта определял именно e-mail
    r = post(pctx, data)
    assert r.status_code == 422, (over, r.text)
    assert r.json()["code"] == "VALIDATION_ERROR"
    assert count_rows(pctx) == 0


@pytest.mark.parametrize("missing", ["business_name", "city", "contact_name", "consent"])
def test_missing_required_fields(pctx: Ctx, missing: str) -> None:
    data = body()
    del data[missing]
    assert post(pctx, data).status_code == 422
    assert count_rows(pctx) == 0


def test_validation_error_does_not_echo_input(pctx: Ctx) -> None:
    r = post(pctx, body(email="secret-person@bad", phone=None))
    assert r.status_code == 422
    assert "secret-person" not in r.text


@pytest.mark.parametrize(
    "raw",
    [b"", b"not json", b"[]", b'"str"', b"null", b"123", b'{"a":', b"\xff\xfe"],
)
def test_non_object_or_broken_json_is_422(pctx: Ctx, raw: bytes) -> None:
    r = post(pctx, raw=raw)
    assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR"


@pytest.mark.parametrize("ctype", ["text/plain", "application/x-www-form-urlencoded", ""])
def test_wrong_content_type_is_415(pctx: Ctx, ctype: str) -> None:
    r = post(pctx, content_type=ctype)
    assert r.status_code == 415 and r.json()["code"] == "UNSUPPORTED_MEDIA_TYPE"
    assert count_rows(pctx) == 0


def test_json_with_charset_is_ok(pctx: Ctx) -> None:
    assert post(pctx, content_type="application/json; charset=utf-8").status_code == 202


def test_too_large_body_is_413(pctx: Ctx) -> None:
    r = post(pctx, raw=b'{"business_name":"' + b"a" * 9000 + b'"}')
    assert r.status_code == 413 and r.json()["code"] == "PAYLOAD_TOO_LARGE"
    assert count_rows(pctx) == 0


def test_too_large_chunked_body_is_413(pctx: Ctx) -> None:
    def gen() -> Any:
        for _ in range(10):
            yield b"a" * 2000

    r = pctx.new_client().post(
        URL,
        content=gen(),
        headers={"Origin": SITE, "Content-Type": "application/json", "X-Forwarded-For": "1.1.1.1"},
    )
    assert r.status_code == 413


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("+7 (900) 123-45-67", "+79001234567"),
        ("+79001234567", "+79001234567"),
        ("89001234567", "+79001234567"),
        ("8 900 123 45 67", "+79001234567"),
        ("7-900-123-45-67", "+79001234567"),
        ("9001234567", "+79001234567"),
        ("(900) 123-45-67", "+79001234567"),
        ("8(843)123-45-67", "+78431234567"),
        ("+7.900.123.45.67", "+79001234567"),
        ("  +7 900 123 45 67  ", "+79001234567"),
        ("+7 495 123-45-67", "+74951234567"),
    ],
)
def test_phone_normalization(raw: str, expected: str) -> None:
    assert normalize_phone_ru(raw) == expected


@pytest.mark.parametrize(
    "raw",
    ["", "+", "12345", "+1 202 555 0143", "+7 (900) 123-45", "9" * 12, "++79001234567",
     "+7 900 123 45 67+", "tel:+79001234567", "+7 900 12a 45 67", "89001234567890",
     "+7 000 000 00 00", "+7 900 000 00 00x", "+7 200 123 45 67"],
)  # fmt: skip
def test_phone_normalization_rejects(raw: str) -> None:
    with pytest.raises(ValueError, match="телефон"):
        normalize_phone_ru(raw)


# ------------------------------------------------------------------ honeypot


@pytest.mark.parametrize("value", ["http://spam", "x", " a ", 1, True, ["a"], {"a": 1}])
def test_honeypot_filled_returns_202_without_record(pctx: Ctx, value: Any) -> None:
    r = post(pctx, body(website=value))
    assert r.status_code == 202 and r.json() == {"status": "accepted"}
    assert count_rows(pctx) == 0


def test_honeypot_wins_over_invalid_fields_and_skips_limits(pctx: Ctx) -> None:
    for _ in range(30):
        r = post(pctx, {"website": "bot", "consent": False})
        assert r.status_code == 202
    assert count_rows(pctx) == 0
    with pctx.db() as db:
        assert db.scalar(select(func.count()).select_from(RateLimitEvent)) == 0
    assert post(pctx).status_code == 202  # честная заявка с того же IP проходит


def test_honeypot_empty_or_whitespace_is_not_a_bot(pctx: Ctx) -> None:
    assert post(pctx, body(website="   ")).status_code == 202
    assert count_rows(pctx) == 1
    assert (
        post(pctx, body(website=None, phone="+79001230000"), ip="203.0.113.50").status_code == 202
    )
    assert count_rows(pctx) == 2


def test_honeypot_response_identical_to_success(pctx: Ctx) -> None:
    ok = post(pctx)
    bot = post(pctx, body(website="x"))
    assert ok.status_code == bot.status_code == 202
    assert ok.json() == bot.json()
    assert set(ok.headers) == set(bot.headers)


# ------------------------------------------------------------------ лимиты


def test_ip_hourly_limit_then_429_with_retry_after(pctx: Ctx) -> None:
    for i in range(5):
        r = post(pctx, body(phone=f"+7900123456{i}"))
        assert r.status_code == 202, r.text
        pctx.clock.advance(60)
    r = post(pctx, body(phone="+79001234569"))
    assert r.status_code == 429 and r.json()["code"] == "RATE_LIMITED"
    # первое событие было 5 минут назад → ждать 55 минут
    assert int(r.headers["Retry-After"]) == 55 * 60
    assert count_rows(pctx) == 5
    pctx.clock.advance(55 * 60)
    assert post(pctx, body(phone="+79001234569")).status_code == 202


def test_other_ip_is_not_limited_by_first_ip(pctx: Ctx) -> None:
    for i in range(5):
        assert post(pctx, body(phone=f"+7900123456{i}")).status_code == 202
    assert post(pctx, body(phone="+79001111111"), ip="203.0.113.99").status_code == 202


def test_ip_daily_limit(make_ctx: Callable[..., Ctx]) -> None:
    ctx = make_ctx(autoflow_origins=SITE, pilot_ip_per_hour=100, pilot_ip_per_day=20)
    for i in range(20):
        assert post(ctx, body(phone=f"+7900200{i:04d}")).status_code == 202
        ctx.clock.advance(30 * 60)  # 20 заявок за 10 часов
    r = post(ctx, body(phone="+79002999999"))
    assert r.status_code == 429
    ctx.clock.advance(24 * 3600)
    assert post(ctx, body(phone="+79002999999")).status_code == 202


def test_global_daily_limit(make_ctx: Callable[..., Ctx]) -> None:
    ctx = make_ctx(autoflow_origins=SITE, pilot_global_per_day=4)
    for i in range(4):
        assert post(ctx, body(phone=f"+7900300000{i}"), ip=f"203.0.113.{i + 1}").status_code == 202
    r = post(ctx, body(phone="+79003000009"), ip="203.0.113.77")
    assert r.status_code == 429 and r.json()["code"] == "RATE_LIMITED"
    assert int(r.headers["Retry-After"]) == 24 * 3600
    ctx.clock.advance(24 * 3600 + 1)
    assert post(ctx, body(phone="+79003000009"), ip="203.0.113.77").status_code == 202


def test_default_limits_match_spec() -> None:
    s = Settings()
    assert (s.pilot_ip_per_hour, s.pilot_ip_per_day, s.pilot_global_per_day) == (5, 20, 300)


def test_duplicates_count_toward_limits(pctx: Ctx) -> None:
    for _ in range(5):
        assert post(pctx).status_code == 202
    assert count_rows(pctx) == 1
    assert post(pctx).status_code == 429


def test_invalid_requests_do_not_consume_limits(pctx: Ctx) -> None:
    for _ in range(10):
        assert post(pctx, body(consent=False)).status_code == 422
    assert post(pctx).status_code == 202


def test_limit_events_stored_in_db_and_old_ones_pruned(pctx: Ctx) -> None:
    post(pctx)
    with pctx.db() as db:
        scopes = sorted(db.scalars(select(RateLimitEvent.scope)))
        keys = list(db.scalars(select(RateLimitEvent.key)))
    assert scopes == ["pilot_all", "pilot_ip"]
    assert "203.0.113.5" not in keys  # ключ — хэш, не IP
    pctx.clock.advance(3 * 24 * 3600)
    post(pctx, body(phone="+79005550000"))
    with pctx.db() as db:
        assert db.scalar(select(func.count()).select_from(RateLimitEvent)) == 2


def test_otp_cleanup_does_not_erase_pilot_windows(pctx: Ctx) -> None:
    for i in range(5):
        assert post(pctx, body(phone=f"+7900123456{i}")).status_code == 202
    pctx.clock.advance(3 * 3600)  # час давно прошёл, суточное окно живо
    assert pctx.request_code("someone@example.com").status_code == 202  # чистка otp старше 2 ч
    with pctx.db() as db:
        n = db.scalar(
            select(func.count())
            .select_from(RateLimitEvent)
            .where(RateLimitEvent.scope == "pilot_ip")
        )
    assert n == 5


# ------------------------------------------------------------------ дедупликация


def test_same_phone_in_other_format_is_not_duplicated(pctx: Ctx) -> None:
    first = post(pctx, body(phone="+7 (900) 123-45-67"))
    second = post(pctx, body(phone="8 900 123 45 67", business_name="Другое имя"))
    assert first.status_code == second.status_code == 202
    assert first.json() == second.json() == {"status": "accepted"}
    assert count_rows(pctx) == 1
    assert rows(pctx)[0].business_name == BUSINESS  # первая заявка не затёрта


def test_same_email_case_insensitive_is_deduplicated(pctx: Ctx) -> None:
    post(pctx, body(phone=None, email="Ivan@Example.com"))
    post(pctx, body(phone=None, email="ivan@example.COM"))
    assert count_rows(pctx) == 1


def test_any_shared_contact_counts_as_duplicate(pctx: Ctx) -> None:
    post(pctx, body(phone=PHONE, email="a@example.com"))
    post(pctx, body(phone="+79009998877", email="a@example.com"))  # общий e-mail
    post(pctx, body(phone=PHONE, email="b@example.com"))  # общий телефон
    assert count_rows(pctx) == 1


def test_different_contacts_are_not_duplicates(pctx: Ctx) -> None:
    post(pctx, body(phone=PHONE))
    post(pctx, body(phone="+79009998877", email="b@example.com"))
    assert count_rows(pctx) == 2


def test_duplicate_response_is_indistinguishable(pctx: Ctx) -> None:
    a = post(pctx)
    b = post(pctx)
    assert (a.status_code, a.json()) == (b.status_code, b.json())
    assert set(a.headers) == set(b.headers)


def test_same_contact_after_24h_creates_new_request(pctx: Ctx) -> None:
    post(pctx)
    pctx.clock.advance(23 * 3600)
    post(pctx, ip="203.0.113.8")
    assert count_rows(pctx) == 1
    pctx.clock.advance(2 * 3600)  # 25 часов с первой заявки
    post(pctx, ip="203.0.113.9")
    assert count_rows(pctx) == 2


def test_dedupe_applies_across_ips_and_statuses(pctx: Ctx) -> None:
    post(pctx)
    owner = login_owner(pctx)
    rid = rows(pctx)[0].id
    r = owner.patch(f"{URL}/{rid}", json={"status": "spam"}, headers=pctx.csrf(owner))
    assert r.status_code == 200
    post(pctx, ip="198.51.100.1")
    assert count_rows(pctx) == 1  # даже spam-заявка блокирует повтор (ничего не раскрываем)


def test_duplicate_writes_no_audit(pctx: Ctx) -> None:
    post(pctx)
    post(pctx)
    assert count_audit(pctx, "pilot_request.created") == 1


# ------------------------------------------------------------------ CORS / Origin


def test_allowed_origin_gets_cors_headers(pctx: Ctx) -> None:
    r = post(pctx)
    assert r.headers["access-control-allow-origin"] == SITE
    assert "origin" in r.headers["vary"].lower()
    assert "access-control-allow-credentials" not in r.headers
    assert "Retry-After" in r.headers["access-control-expose-headers"]


@pytest.mark.parametrize(
    "origin",
    [
        "https://evil.example",
        "http://autoflow.example.com",  # другая схема
        "https://autoflow.example.com.evil.example",
        "https://sub.autoflow.example.com",
        "https://autoflow.example.com:8443",
        "null",
        "*",
        "http://localhost:3000",  # PUBLIC_ORIGIN самого LeadHunter — не форма
    ],
)
def test_foreign_origin_is_403_without_record_or_cors(pctx: Ctx, origin: str) -> None:
    r = post(pctx, origin=origin)
    assert r.status_code == 403 and r.json()["code"] == "ORIGIN_FORBIDDEN"
    assert "access-control-allow-origin" not in r.headers
    assert count_rows(pctx) == 0


def test_missing_origin_and_referer_is_403(pctx: Ctx) -> None:
    r = post(pctx, origin=None)
    assert r.status_code == 403 and r.json()["code"] == "ORIGIN_FORBIDDEN"
    assert count_rows(pctx) == 0


def test_referer_fallback_when_origin_absent(pctx: Ctx) -> None:
    ok = post(pctx, origin=None, headers={"Referer": SITE + "/pilot?x=1"})
    assert ok.status_code == 202 and ok.headers["access-control-allow-origin"] == SITE
    bad = post(pctx, origin=None, headers={"Referer": "https://evil.example/p"}, ip="1.2.3.4")
    assert bad.status_code == 403


def test_origin_takes_precedence_over_referer(pctx: Ctx) -> None:
    r = post(pctx, origin="https://evil.example", headers={"Referer": SITE + "/"})
    assert r.status_code == 403


def test_origin_trailing_slash_and_case_normalized(pctx: Ctx) -> None:
    r = post(pctx, origin=SITE.upper() + "/")
    assert r.status_code == 202
    assert r.headers["access-control-allow-origin"] == SITE  # эхо нормализованного значения


def test_default_empty_origins_closes_the_endpoint(make_ctx: Callable[..., Ctx]) -> None:
    ctx = make_ctx()
    assert ctx.settings.autoflow_origin_set == frozenset()
    for origin in (SITE, "http://localhost:3000", None):
        assert post(ctx, origin=origin).status_code == 403
    assert count_rows(ctx) == 0


def test_multiple_origins_each_echoed_separately(make_ctx: Callable[..., Ctx]) -> None:
    other = "https://pilot.example.org"
    ctx = make_ctx(autoflow_origins=f"{SITE}, {other}/ ,")
    assert ctx.settings.autoflow_origin_set == {SITE, other}
    r1 = post(ctx, origin=other)
    r2 = post(ctx, body(phone="+79001112233"), origin=SITE, ip="1.1.1.1")
    assert r1.headers["access-control-allow-origin"] == other
    assert r2.headers["access-control-allow-origin"] == SITE


def test_autoflow_domain_becomes_https_origin(make_ctx: Callable[..., Ctx]) -> None:
    ctx = make_ctx(autoflow_domain="Autoflow.Example.COM")
    assert ctx.settings.autoflow_origin_set == {"https://autoflow.example.com"}
    assert post(ctx, origin="https://autoflow.example.com").status_code == 202
    assert post(ctx, origin="http://autoflow.example.com", ip="1.2.3.4").status_code == 403


def test_domain_and_origins_are_merged(make_ctx: Callable[..., Ctx]) -> None:
    ctx = make_ctx(autoflow_origins=SITE, autoflow_domain="b.example.org")
    assert ctx.settings.autoflow_origin_set == {SITE, "https://b.example.org"}


def test_429_response_also_carries_cors_headers(pctx: Ctx) -> None:
    for i in range(5):
        post(pctx, body(phone=f"+7900123456{i}"))
    r = post(pctx, body(phone="+79001234569"))
    assert r.status_code == 429
    assert r.headers["access-control-allow-origin"] == SITE  # браузер сможет прочитать ответ


def test_validation_error_response_carries_cors_headers(pctx: Ctx) -> None:
    r = post(pctx, body(consent=False))
    assert r.status_code == 422 and r.headers["access-control-allow-origin"] == SITE


def test_preflight_allowed(pctx: Ctx) -> None:
    r = pctx.new_client().options(
        URL,
        headers={
            "Origin": SITE,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert r.status_code == 204
    assert r.headers["access-control-allow-origin"] == SITE
    assert r.headers["access-control-allow-methods"] == "POST, OPTIONS"
    assert r.headers["access-control-allow-headers"] == "Content-Type"
    assert int(r.headers["access-control-max-age"]) > 0
    assert "access-control-allow-credentials" not in r.headers
    assert count_rows(pctx) == 0


def test_preflight_foreign_origin_forbidden(pctx: Ctx) -> None:
    r = pctx.new_client().options(
        URL, headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"}
    )
    assert r.status_code == 403 and "access-control-allow-origin" not in r.headers


def test_other_endpoints_get_no_cors_for_autoflow_origin(pctx: Ctx) -> None:
    owner = login_owner(pctx)
    r = owner.get(URL, headers={"Origin": SITE})
    assert r.status_code == 200 and "access-control-allow-origin" not in r.headers
    r = pctx.new_client().options("/api/v1/dashboard", headers={"Origin": SITE})
    assert "access-control-allow-origin" not in r.headers


def test_autoflow_origin_cannot_mutate_owner_endpoints(pctx: Ctx) -> None:
    post(pctx)
    owner = login_owner(pctx)
    rid = rows(pctx)[0].id
    headers = {**pctx.csrf(owner), "Origin": SITE}
    r = owner.patch(URL + f"/{rid}", json={"status": "contacted"}, headers=headers)
    assert r.status_code == 403 and r.json()["code"] == "ORIGIN_FORBIDDEN"
    assert rows(pctx)[0].status == "new"
    r = owner.post("/api/v1/auth/logout", headers=headers)
    assert r.status_code == 403  # остальные мутации по-прежнему только с PUBLIC_ORIGIN


def test_get_on_public_path_is_not_public(pctx: Ctx) -> None:
    assert pctx.new_client().get(URL, headers={"Origin": SITE}).status_code == 401


# ------------------------------------------------------------------ конфигурация


def _settings(**kw: Any) -> Settings:
    base: dict[str, Any] = {
        "env": "prod",
        "database_url": "postgresql://u:p@localhost/db",
        "secret_key": "x" * 40,
        "mail_backend": "smtp",
        "smtp_host": "smtp.example.com",
    }
    base.update(kw)
    return Settings(**base)


def test_prod_requires_https_autoflow_origins() -> None:
    assert _settings(autoflow_origins="https://a.example.com").autoflow_origin_set == {
        "https://a.example.com"
    }
    with pytest.raises(ValueError, match="https"):
        _settings(autoflow_origins="http://a.example.com")


@pytest.mark.parametrize(
    "value",
    ["*", "https://*.example.com", "https://a.example.com/path", "a.example.com", "ftp://a.b",
     "https://u:p@a.example.com", "https://a.example.com?x=1", "https://a.example.com#f"],
)  # fmt: skip
def test_bad_autoflow_origins_rejected(value: str) -> None:
    with pytest.raises(ValueError, match="AUTOFLOW_ORIGINS"):
        Settings(autoflow_origins=value)


@pytest.mark.parametrize(
    "value", ["https://a.example.com", "a.example.com/x", "*.example.com", "a b.com", "localhost"]
)
def test_bad_autoflow_domain_rejected(value: str) -> None:
    with pytest.raises(ValueError, match="AUTOFLOW_DOMAIN"):
        Settings(autoflow_domain=value)


def test_prod_domain_gives_https_origin() -> None:
    assert _settings(autoflow_domain="autoflow.example.com").autoflow_origin_set == {
        "https://autoflow.example.com"
    }


def test_defaults_are_closed_and_env_vars_are_read(monkeypatch: pytest.MonkeyPatch) -> None:
    assert Settings().autoflow_origin_set == frozenset()
    monkeypatch.setenv("AUTOFLOW_ORIGINS", "")
    monkeypatch.setenv("AUTOFLOW_DOMAIN", "")
    assert Settings().autoflow_origin_set == frozenset()
    monkeypatch.setenv("AUTOFLOW_ORIGINS", SITE)
    assert Settings().autoflow_origin_set == {SITE}


# ------------------------------------------------------------------ персональные данные


def test_audit_and_logs_have_no_personal_data(pctx: Ctx, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    data = body(email="secret.person@example.com", phone=PHONE, contact_name="Секретный Человек")
    assert post(pctx, data).status_code == 202
    assert post(pctx, data).status_code == 202  # дубль
    assert post(pctx, body(consent=False)).status_code == 422
    owner = login_owner(pctx)
    rid = rows(pctx)[0].id
    note = "Звонил на 89001234567, ждёт письмо secret.person@example.com"
    r = owner.patch(
        URL + f"/{rid}", json={"status": "contacted", "note": note}, headers=pctx.csrf(owner)
    )
    assert r.status_code == 200
    with pctx.db() as db:
        audit = [
            {"a": a.action, "e": a.entity, "i": a.entity_id, "m": a.meta}
            for a in db.scalars(select(AuditLog))
        ]
    blob = (
        json.dumps(audit, ensure_ascii=False)
        + "\n"
        + "\n".join(rec.getMessage() for rec in caplog.records)
    )
    for secret in (
        "secret.person",
        "Секретный",
        "900",
        "123-45-67",
        "1234567",
        "Север",
        "Казань",
        "Звонил",
        "ждёт",
        "203.0.113.5",
    ):
        assert secret not in blob, secret
    actions = {a["a"] for a in audit}
    assert {"pilot_request.created", "pilot_request.update"} <= actions


def test_created_audit_has_only_flags(pctx: Ctx) -> None:
    post(pctx, body(email="a@example.com"))
    with pctx.db() as db:
        row = db.scalar(select(AuditLog).where(AuditLog.action == "pilot_request.created"))
    assert row is not None
    assert row.actor_id is None and row.entity == "pilot_request"
    assert row.entity_id == str(rows(pctx)[0].id)
    assert row.meta == {
        "has_phone": True,
        "has_email": True,
        "consent_text_version": pctx.settings.pilot_consent_version,
    }


def test_owner_response_has_no_ip_hash_or_user_agent(pctx: Ctx) -> None:
    post(pctx)
    owner = login_owner(pctx)
    item = owner.get(URL).json()["items"][0]
    assert set(item) == {
        "id", "business_name", "city", "contact_name", "phone", "email", "status", "note",
        "consent_at", "consent_text_version", "created_at", "updated_at",
    }  # fmt: skip


# ------------------------------------------------------------------ кабинет владельца


def seed(ctx: Ctx, n: int, *, status: str = "new", same_time: bool = False) -> list[uuid.UUID]:
    ids: list[uuid.UUID] = []
    base = ctx.clock.now()
    with ctx.db() as db:
        for i in range(n):
            t = base if same_time else base.replace(microsecond=i + 1)
            rid = uuid.uuid4()
            ids.append(rid)
            db.add(
                PilotRequest(
                    id=rid,
                    business_name=f"Автосервис {i}",
                    city="Казань",
                    contact_name="Иван",
                    phone=f"+7900{i:07d}",
                    status=status,
                    consent_at=t,
                    consent_text_version="v1",
                    created_at=t,
                    updated_at=t,
                )
            )
        db.commit()
    return ids


def test_list_requires_login_and_owner(pctx: Ctx) -> None:
    assert pctx.new_client().get(URL).status_code == 401
    owner = login_owner(pctx)
    pending = login_pending(pctx)
    r = pending.get(URL)
    assert r.status_code == 403 and r.json()["code"] == "ACCOUNT_PENDING"
    user = login_active_user(pctx, owner, "bob@example.com")
    r = user.get(URL)
    assert r.status_code == 403 and r.json()["code"] == "FORBIDDEN"
    assert owner.get(URL).status_code == 200


def test_patch_requires_owner_and_csrf(pctx: Ctx) -> None:
    (rid,) = seed(pctx, 1)
    path = f"{URL}/{rid}"
    assert pctx.new_client().patch(path, json={"status": "spam"}).status_code == 401
    owner = login_owner(pctx)
    user = login_active_user(pctx, owner, "bob@example.com")
    r = user.patch(path, json={"status": "spam"}, headers=pctx.csrf(user))
    assert r.status_code == 403 and r.json()["code"] == "FORBIDDEN"
    r = owner.patch(path, json={"status": "spam"})
    assert r.status_code == 403 and r.json()["code"] == "CSRF_FAILED"
    r = owner.patch(path, json={"status": "spam"}, headers={"X-CSRF-Token": "wrong"})
    assert r.status_code == 403
    assert rows(pctx)[0].status == "new"
    assert count_audit(pctx, "pilot_request.update") == 0


def test_list_shape_and_order(pctx: Ctx) -> None:
    ids = seed(pctx, 3)
    owner = login_owner(pctx)
    d = owner.get(URL).json()
    assert d["next_cursor"] is None
    assert [i["id"] for i in d["items"]] == [str(i) for i in reversed(ids)]  # новые сверху
    first = d["items"][0]
    assert first["status"] == "new" and first["phone"].startswith("+7900")
    assert first["created_at"].endswith("+00:00")


def test_empty_list(pctx: Ctx) -> None:
    owner = login_owner(pctx)
    assert owner.get(URL).json() == {"items": [], "next_cursor": None}


def test_filter_by_status(pctx: Ctx) -> None:
    seed(pctx, 2, status="new")
    seed(pctx, 3, status="contacted")
    owner = login_owner(pctx)
    assert len(owner.get(URL, params={"status": "new"}).json()["items"]) == 2
    assert len(owner.get(URL, params={"status": "contacted"}).json()["items"]) == 3
    assert owner.get(URL, params={"status": "accepted"}).json()["items"] == []
    assert owner.get(URL, params={"status": "bogus"}).status_code == 422


def test_cursor_pagination_with_identical_timestamps(pctx: Ctx) -> None:
    ids = seed(pctx, 7, same_time=True)  # одинаковый created_at: порядок держится на id
    owner = login_owner(pctx)
    seen: list[str] = []
    cursor: str | None = None
    pages = 0
    while True:
        params: dict[str, Any] = {"limit": 3}
        if cursor:
            params["cursor"] = cursor
        d = owner.get(URL, params=params).json()
        seen += [i["id"] for i in d["items"]]
        pages += 1
        cursor = d["next_cursor"]
        if not cursor:
            break
    assert pages == 3 and len(seen) == 7 and set(seen) == {str(i) for i in ids}
    assert seen == sorted(seen, reverse=True)


def test_cursor_pagination_by_time_and_status_filter(pctx: Ctx) -> None:
    seed(pctx, 5, status="new")
    seed(pctx, 4, status="spam")
    owner = login_owner(pctx)
    d1 = owner.get(URL, params={"status": "new", "limit": 2}).json()
    d2 = owner.get(URL, params={"status": "new", "limit": 2, "cursor": d1["next_cursor"]}).json()
    d3 = owner.get(URL, params={"status": "new", "limit": 2, "cursor": d2["next_cursor"]}).json()
    items = [i for d in (d1, d2, d3) for i in d["items"]]
    assert len(items) == 5 and len({i["id"] for i in items}) == 5 and d3["next_cursor"] is None
    assert all(i["status"] == "new" for i in items)


@pytest.mark.parametrize("cursor", ["x", "!!!", "e30", "bnVsbA", "eyJ0IjoiYSJ9", "a" * 600])
def test_invalid_cursor_is_422(pctx: Ctx, cursor: str) -> None:
    owner = login_owner(pctx)
    assert owner.get(URL, params={"cursor": cursor}).status_code == 422


def test_cursor_from_other_filter_is_rejected(pctx: Ctx) -> None:
    seed(pctx, 5)
    owner = login_owner(pctx)
    cursor = owner.get(URL, params={"limit": 2}).json()["next_cursor"]
    r = owner.get(URL, params={"limit": 2, "status": "new", "cursor": cursor})
    assert r.status_code == 422 and r.json()["code"] == "INVALID_CURSOR"


@pytest.mark.parametrize("limit", [0, -1, 101, "abc"])
def test_bad_limit_is_422(pctx: Ctx, limit: Any) -> None:
    owner = login_owner(pctx)
    assert owner.get(URL, params={"limit": limit}).status_code == 422


def test_patch_status_and_note_with_audit(pctx: Ctx) -> None:
    (rid,) = seed(pctx, 1)
    owner = login_owner(pctx)
    pctx.clock.advance(600)
    r = owner.patch(
        f"{URL}/{rid}",
        json={"status": "contacted", "note": "  Перезвонить\n\n завтра  "},
        headers=pctx.csrf(owner),
    )
    assert r.status_code == 200
    d = r.json()
    assert d["status"] == "contacted" and d["note"] == "Перезвонить\n\nзавтра"
    assert d["updated_at"] != d["created_at"]
    with pctx.db() as db:
        a = db.scalar(select(AuditLog).where(AuditLog.action == "pilot_request.update"))
    assert a is not None and a.actor_id == pctx.user(OWNER).id and a.entity_id == str(rid)
    assert a.meta == {"status_from": "new", "status_to": "contacted", "note_changed": True}


def test_patch_only_note_or_only_status(pctx: Ctx) -> None:
    (rid,) = seed(pctx, 1)
    owner = login_owner(pctx)
    h = pctx.csrf(owner)
    assert owner.patch(f"{URL}/{rid}", json={"note": "x"}, headers=h).json()["status"] == "new"
    assert owner.patch(f"{URL}/{rid}", json={"status": "accepted"}, headers=h).json()["note"] == "x"
    assert owner.patch(f"{URL}/{rid}", json={"note": ""}, headers=h).json()["note"] == ""


def test_patch_without_changes_writes_no_audit(pctx: Ctx) -> None:
    (rid,) = seed(pctx, 1)
    owner = login_owner(pctx)
    r = owner.patch(f"{URL}/{rid}", json={"status": "new"}, headers=pctx.csrf(owner))
    assert r.status_code == 200
    assert count_audit(pctx, "pilot_request.update") == 0


@pytest.mark.parametrize(
    "payload",
    [{}, {"status": "bogus"}, {"status": None}, {"status": 1}, {"note": 5}, {"note": "x" * 2001},
     {"note": "a\x00b"}, {"phone": "+79001112233"}, {"status": "new", "id": "x"},
     {"consent_at": "2020-01-01"}, {"business_name": "Взлом"}],
)  # fmt: skip
def test_patch_validation(pctx: Ctx, payload: dict[str, Any]) -> None:
    (rid,) = seed(pctx, 1)
    owner = login_owner(pctx)
    r = owner.patch(f"{URL}/{rid}", json=payload, headers=pctx.csrf(owner))
    assert r.status_code == 422, payload
    assert rows(pctx)[0].business_name == "Автосервис 0"


def test_patch_unknown_and_malformed_id(pctx: Ctx) -> None:
    owner = login_owner(pctx)
    h = pctx.csrf(owner)
    r = owner.patch(f"{URL}/{uuid.uuid4()}", json={"status": "spam"}, headers=h)
    assert r.status_code == 404 and r.json()["code"] == "NOT_FOUND"
    assert owner.patch(f"{URL}/not-a-uuid", json={"status": "spam"}, headers=h).status_code == 422


@pytest.mark.parametrize("status", ["new", "contacted", "accepted", "declined", "spam"])
def test_all_statuses_settable(pctx: Ctx, status: str) -> None:
    (rid,) = seed(pctx, 1, status="declined")
    owner = login_owner(pctx)
    r = owner.patch(f"{URL}/{rid}", json={"status": status}, headers=pctx.csrf(owner))
    assert r.status_code == 200 and r.json()["status"] == status


# ------------------------------------------------------------------ дашборд


def test_dashboard_counts_new_requests_for_owner_only(pctx: Ctx) -> None:
    seed(pctx, 3, status="new")
    seed(pctx, 2, status="contacted")
    seed(pctx, 1, status="spam")
    owner = login_owner(pctx)
    assert owner.get("/api/v1/dashboard").json()["pilot_requests_new"] == 3
    user = login_active_user(pctx, owner, "bob@example.com")
    assert user.get("/api/v1/dashboard").json()["pilot_requests_new"] is None


def test_dashboard_counter_follows_status_changes(pctx: Ctx) -> None:
    owner = login_owner(pctx)
    assert owner.get("/api/v1/dashboard").json()["pilot_requests_new"] == 0
    post(pctx)
    post(pctx, body(phone="+79005554433"), ip="198.51.100.2")
    assert owner.get("/api/v1/dashboard").json()["pilot_requests_new"] == 2
    rid = rows(pctx)[0].id
    owner.patch(f"{URL}/{rid}", json={"status": "accepted"}, headers=pctx.csrf(owner))
    assert owner.get("/api/v1/dashboard").json()["pilot_requests_new"] == 1
