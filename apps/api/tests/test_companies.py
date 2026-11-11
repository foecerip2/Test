"""Компании: список, фильтры, пагинация, карточка, стадии, отклонение, экспорт, дашборд."""

from __future__ import annotations

import base64
import json
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.config import Settings
from app.models import (
    COMPANY_STATES,
    CRM_STAGES,
    ActivityEvent,
    AuditLog,
    Company,
    CompanyFact,
    LeadScore,
)
from app.security import AppError
from app.services import companies as svc
from app.services.normalize import to_csv
from tests.conftest import Ctx
from tests.helpers import (
    add_company,
    add_fact,
    csv_text,
    login_active_user,
    login_owner,
    login_pending,
    post_import,
)

API = "/api/v1/companies"
EXPORT_HEADER = '"Компания";"Город";"Категория";"Сайт";"Оценка";"Статус"'


def _ids(r: Any) -> list[str]:
    return [i["id"] for i in r.json()["items"]]


def _names(r: Any) -> list[str]:
    return [i["name"] for i in r.json()["items"]]


# ---------------------------------------------------------------- доступ


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", API),
        ("GET", f"{API}/export"),
        ("GET", f"{API}/{uuid.uuid4()}"),
        ("PATCH", f"{API}/{uuid.uuid4()}"),
        ("POST", f"{API}/{uuid.uuid4()}/reject"),
        ("GET", "/api/v1/dashboard"),
        ("POST", "/api/v1/imports/companies"),
    ],
)
def test_anonymous_gets_401(ctx: Ctx, method: str, path: str) -> None:
    assert ctx.client.request(method, path).status_code == 401


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", API),
        ("GET", f"{API}/export"),
        ("GET", f"{API}/{uuid.uuid4()}"),
        ("PATCH", f"{API}/{uuid.uuid4()}"),
        ("POST", f"{API}/{uuid.uuid4()}/reject"),
        ("GET", "/api/v1/dashboard"),
    ],
)
def test_pending_user_gets_403(ctx: Ctx, method: str, path: str) -> None:
    login_owner(ctx)
    pending = login_pending(ctx)
    r = pending.request(method, path, json={"stage": "new"} if method == "PATCH" else None)
    assert r.status_code == 403 and r.json()["code"] == "ACCOUNT_PENDING"


def test_blocked_user_is_rejected(ctx: Ctx) -> None:
    owner = login_owner(ctx)
    user = login_active_user(ctx, owner)
    assert user.get(API).status_code == 200
    uid = ctx.user("alice@example.com").id
    owner.post(f"/api/v1/admin/users/{uid}/block", headers=ctx.csrf(owner))
    assert user.get(API).status_code == 401


def test_mutations_need_csrf(ctx: Ctx) -> None:
    login_owner(ctx)
    cid = add_company(ctx)
    r = ctx.client.patch(f"{API}/{cid}", json={"stage": "contacted"})
    assert r.status_code == 403 and r.json()["code"] == "CSRF_FAILED"
    r = ctx.client.post(f"{API}/{cid}/reject")
    assert r.status_code == 403 and r.json()["code"] == "CSRF_FAILED"
    bad = {"X-CSRF-Token": "wrong"}
    assert ctx.client.patch(f"{API}/{cid}", json={"note": "x"}, headers=bad).status_code == 403
    with ctx.db() as db:
        c = db.get(Company, cid)
        assert c is not None and c.stage == "new" and c.state == "discovered" and c.note == ""


def test_non_owner_active_user_can_work(ctx: Ctx) -> None:
    owner = login_owner(ctx)
    user = login_active_user(ctx, owner)
    cid = add_company(ctx)
    r = user.patch(f"{API}/{cid}", json={"stage": "contacted"}, headers=ctx.csrf(user))
    assert r.status_code == 200 and r.json()["stage"] == "contacted"


# ---------------------------------------------------------------- список и фильтры


def test_list_shape_and_cities(ctx: Ctx) -> None:
    login_owner(ctx)
    add_company(ctx, "Север Авто", "Казань", domain="sever.example", inn="7707083893")
    add_company(ctx, "Гараж 24", "Уфа")
    r = ctx.client.get(API)
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"items", "total", "cities", "has_more", "next_cursor"}
    assert body["total"] == 2 and body["cities"] == ["Казань", "Уфа"]
    assert body["has_more"] is False and body["next_cursor"] is None
    item = next(i for i in body["items"] if i["name"] == "Север Авто")
    assert set(item) == {
        "id",
        "name",
        "city",
        "category",
        "website",
        "domain",
        "inn",
        "state",
        "stage",
        "score",
        "display",
        "source_label",
        "created_at",
        "updated_at",
        "demo",
        "duplicate_candidate",
    }
    assert item["domain"] == "sever.example" and item["website"] == "https://sever.example"
    assert item["display"] == {"key": "new", "label": "Новый", "tone": "neutral"}
    assert item["state"] == "discovered" and item["stage"] == "new"


def test_empty_database(ctx: Ctx) -> None:
    login_owner(ctx)
    body = ctx.client.get(API).json()
    assert body == {"items": [], "total": 0, "cities": [], "has_more": False, "next_cursor": None}


def test_filter_query_case_and_yo_insensitive(ctx: Ctx) -> None:
    login_owner(ctx)
    add_company(ctx, "СТО «Ёжик»", "Казань", domain="ezhik.example")
    add_company(ctx, "Мотор", "Уфа", category="Шиномонтаж")
    assert _names(ctx.client.get(API, params={"query": "ЕЖИК"})) == ["СТО «Ёжик»"]
    assert _names(ctx.client.get(API, params={"query": "ёжик"})) == ["СТО «Ёжик»"]
    assert _names(ctx.client.get(API, params={"query": "ezhik.example"})) == ["СТО «Ёжик»"]
    assert _names(ctx.client.get(API, params={"query": "шиномонт"})) == ["Мотор"]
    assert _names(ctx.client.get(API, params={"query": "уфа"})) == ["Мотор"]
    assert ctx.client.get(API, params={"query": "нет такого"}).json()["total"] == 0


def test_filter_query_treats_wildcards_literally(ctx: Ctx) -> None:
    login_owner(ctx)
    add_company(ctx, "Скидка 50% авто", "Казань")
    add_company(ctx, "Обычная", "Казань")
    assert _names(ctx.client.get(API, params={"query": "%"})) == ["Скидка 50% авто"]
    assert ctx.client.get(API, params={"query": "_"}).json()["total"] == 0


def test_filter_city_uses_normalization(ctx: Ctx) -> None:
    login_owner(ctx)
    add_company(ctx, "А", "Санкт-Петербург")
    add_company(ctx, "Б", "Казань")
    assert _names(ctx.client.get(API, params={"city": "Санкт-Петербург"})) == ["А"]
    assert _names(ctx.client.get(API, params={"city": "спб"})) == ["А"]
    assert _names(ctx.client.get(API, params={"city": "г. казань"})) == ["Б"]


def test_filter_score_min_and_status(ctx: Ctx) -> None:
    login_owner(ctx)
    add_company(ctx, "Высокий", score=90)
    add_company(ctx, "Средний", score=50, stage="contacted")
    add_company(ctx, "Низкий", score=10, stage="lost")
    add_company(ctx, "Отклонён", score=80, state="rejected")
    add_company(ctx, "Пилот", score=70, stage="pilot")
    assert set(_names(ctx.client.get(API, params={"score_min": 75}))) == {"Высокий", "Отклонён"}
    assert _names(ctx.client.get(API, params={"status": "refused"})) == ["Низкий"]
    assert _names(ctx.client.get(API, params={"status": "rejected"})) == ["Отклонён"]
    assert _names(ctx.client.get(API, params={"status": "contacted"})) == ["Средний"]
    assert _names(ctx.client.get(API, params={"status": "pilot"})) == ["Пилот"]
    assert _names(ctx.client.get(API, params={"status": "new"})) == ["Высокий"]
    both = ctx.client.get(API, params={"status": "pilot", "score_min": 80})
    assert both.json()["total"] == 0


def test_combined_filters_total_ignores_cursor(ctx: Ctx) -> None:
    login_owner(ctx)
    for i in range(5):
        add_company(ctx, f"Казанская {i}", "Казань", score=60 + i)
    add_company(ctx, "Уфимская", "Уфа", score=99)
    body = ctx.client.get(API, params={"city": "Казань", "limit": 2}).json()
    assert body["total"] == 5 and len(body["items"]) == 2 and body["has_more"] is True
    r2 = ctx.client.get(API, params={"city": "Казань", "limit": 2, "cursor": body["next_cursor"]})
    assert r2.json()["total"] == 5  # total — по фильтрам, не по остатку


@pytest.mark.parametrize(
    "params",
    [
        {"limit": 0},
        {"limit": 201},
        {"score_min": 101},
        {"score_min": -1},
        {"sort": "price"},
        {"dir": "up"},
        {"status": "weird"},
    ],
)
def test_invalid_query_params_are_422(ctx: Ctx, params: dict[str, Any]) -> None:
    login_owner(ctx)
    r = ctx.client.get(API, params=params)
    assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR"


# ---------------------------------------------------------------- сортировка и курсор


def test_sort_score_desc_by_default_and_asc(ctx: Ctx) -> None:
    login_owner(ctx)
    for name, s in (("Б", 40), ("А", 90), ("В", 65)):
        add_company(ctx, name, score=s)
    assert _names(ctx.client.get(API)) == ["А", "В", "Б"]
    assert _names(ctx.client.get(API, params={"dir": "asc"})) == ["Б", "В", "А"]


def test_sort_name_default_asc_and_desc(ctx: Ctx) -> None:
    login_owner(ctx)
    for name in ("Волна", "ООО «Альфа»", "Берег"):
        add_company(ctx, name)
    assert _names(ctx.client.get(API, params={"sort": "name"})) == [
        "ООО «Альфа»",
        "Берег",
        "Волна",
    ]
    assert _names(ctx.client.get(API, params={"sort": "name", "dir": "desc"})) == [
        "Волна",
        "Берег",
        "ООО «Альфа»",
    ]


def test_sort_updated(ctx: Ctx) -> None:
    login_owner(ctx)
    base = datetime(2026, 1, 1, tzinfo=UTC)
    for i, name in enumerate(("Старая", "Средняя", "Новая")):
        add_company(ctx, name, updated_at=base + timedelta(days=i))
    assert _names(ctx.client.get(API, params={"sort": "updated"})) == ["Новая", "Средняя", "Старая"]
    asc = ctx.client.get(API, params={"sort": "updated", "dir": "asc"})
    assert _names(asc) == ["Старая", "Средняя", "Новая"]


@pytest.mark.parametrize(
    ("sort", "dir_"),
    [("score", "desc"), ("score", "asc"), ("name", "asc"), ("name", "desc"), ("updated", "desc")],
)
def test_pagination_walks_everything_exactly_once(ctx: Ctx, sort: str, dir_: str) -> None:
    """25 компаний с повторяющимися значениями сортировки: ни пропусков, ни повторов."""
    login_owner(ctx)
    stamp = datetime(2026, 5, 5, tzinfo=UTC)
    for i in range(25):
        add_company(
            ctx,
            f"Компания {i % 5}",  # одинаковые имена
            score=[10, 50, 50, 50, 90][i % 5],  # много равных оценок
            updated_at=stamp + timedelta(hours=i % 3),  # равные даты
        )
    seen: list[str] = []
    cursor: str | None = None
    pages = 0
    while True:
        params: dict[str, Any] = {"sort": sort, "dir": dir_, "limit": 4}
        if cursor:
            params["cursor"] = cursor
        body = ctx.client.get(API, params=params).json()
        pages += 1
        seen += [i["id"] for i in body["items"]]
        assert body["total"] == 25
        if not body["has_more"]:
            assert body["next_cursor"] is None
            break
        assert body["next_cursor"] and len(body["items"]) == 4
        cursor = body["next_cursor"]
    assert pages == 7 and len(seen) == 25 and len(set(seen)) == 25


def test_stable_order_for_equal_scores(ctx: Ctx) -> None:
    login_owner(ctx)
    for i in range(12):
        add_company(ctx, f"Равная {i}", score=70)
    first = _ids(ctx.client.get(API, params={"limit": 200}))
    second = _ids(ctx.client.get(API, params={"limit": 200}))
    assert first == second and len(set(first)) == 12
    assert first == sorted(first, reverse=True)  # tie-breaker — id (убывание при dir=desc)
    paged: list[str] = []
    cursor: str | None = None
    while True:
        params: dict[str, Any] = {"limit": 5}
        if cursor:
            params["cursor"] = cursor
        resp = ctx.client.get(API, params=params)
        paged += _ids(resp)
        cursor = resp.json()["next_cursor"]
        if not cursor:
            break
    assert paged == first


def test_cursor_stays_valid_when_data_is_added(ctx: Ctx) -> None:
    login_owner(ctx)
    for i in range(6):
        add_company(ctx, f"К{i}", score=80 - i)
    page1 = ctx.client.get(API, params={"limit": 3}).json()
    add_company(ctx, "Новая сверху", score=100)  # появилась выше курсора — страница 2 не сдвигается
    page2 = ctx.client.get(API, params={"limit": 3, "cursor": page1["next_cursor"]}).json()
    assert [i["name"] for i in page2["items"]] == ["К3", "К4", "К5"]


@pytest.mark.parametrize("bad", ["garbage", "e30", "eyJzIjoic2NvcmUifQ", "!!!"])
def test_garbage_cursor_is_422(ctx: Ctx, bad: str) -> None:
    login_owner(ctx)
    add_company(ctx)
    r = ctx.client.get(API, params={"cursor": bad})
    assert r.status_code == 422 and r.json()["code"] == "INVALID_CURSOR"


def test_empty_cursor_means_first_page(ctx: Ctx) -> None:
    login_owner(ctx)
    add_company(ctx)
    assert ctx.client.get(API, params={"cursor": ""}).json()["total"] == 1


def test_cursor_bound_to_sort_and_dir_and_types(ctx: Ctx) -> None:
    login_owner(ctx)
    for i in range(4):
        add_company(ctx, f"К{i}", score=50 + i)
    cur = ctx.client.get(API, params={"limit": 2}).json()["next_cursor"]
    assert ctx.client.get(API, params={"limit": 2, "cursor": cur}).status_code == 200
    r = ctx.client.get(API, params={"limit": 2, "cursor": cur, "sort": "name"})
    assert r.status_code == 422 and r.json()["code"] == "INVALID_CURSOR"
    r = ctx.client.get(API, params={"limit": 2, "cursor": cur, "dir": "asc"})
    assert r.status_code == 422

    def forge(**kw: Any) -> str:
        base = {"s": "score", "d": "desc", "v": 1, "i": str(uuid.uuid4())}
        return base64.urlsafe_b64encode(json.dumps({**base, **kw}).encode()).decode().rstrip("=")

    for forged in (forge(v="1; DROP TABLE companies"), forge(i="не-uuid"), forge(v=True)):
        r = ctx.client.get(API, params={"cursor": forged})
        assert r.status_code == 422, forged
    assert ctx.client.get(API, params={"cursor": forge()}).status_code == 200


# ---------------------------------------------------------------- карточка


def test_detail_has_facts_reasons_history(ctx: Ctx) -> None:
    owner = login_owner(ctx)
    r = post_import(ctx, owner, csv_text("Север;Казань;sever.example;;Автосервис"), dry_run=False)
    assert r.json()["added"] == 1
    cid = uuid.UUID(ctx.client.get(API).json()["items"][0]["id"])
    base = datetime(2026, 10, 1, tzinfo=UTC)
    add_fact(
        ctx,
        cid,
        kind="hypothesis",
        text="Возможно, нет онлайн-записи",
        url=None,
        excerpt=None,
        observed_at=base + timedelta(days=5),
        confidence=0.4,
    )
    add_fact(ctx, cid, kind="confirmed", text="Старый факт", observed_at=base)
    add_fact(ctx, cid, kind="confirmed", text="Свежий факт", observed_at=base + timedelta(days=9))
    d = ctx.client.get(f"{API}/{cid}").json()
    assert [f["text"] for f in d["facts"]] == [
        "Свежий факт",
        "Старый факт",
        "Возможно, нет онлайн-записи",
    ]
    assert [f["kind"] for f in d["facts"]] == ["confirmed", "confirmed", "hypothesis"]
    assert d["facts"][0]["evidence_url"] and d["facts"][2]["evidence_url"] is None
    assert d["score_version"] == "rules-v1" and d["score"] == 35
    assert [x["max"] for x in d["score_reasons"]] == [25, 20, 15, 15, 15, 10]
    assert sum(x["points"] for x in d["score_reasons"]) == d["score"]
    assert all(x["note"] for x in d["score_reasons"])
    first = d["history"][0]
    assert first["title"] == "Импортирована из CSV" and first["icon"] == "download"
    assert first["text"] == "Строка 2"
    assert d["contacts"] == [] and d["draft_id"] is None and d["note"] == ""


def test_detail_404_and_bad_uuid(ctx: Ctx) -> None:
    login_owner(ctx)
    r = ctx.client.get(f"{API}/{uuid.uuid4()}")
    assert r.status_code == 404 and r.json()["code"] == "NOT_FOUND"
    assert ctx.client.get(f"{API}/not-a-uuid").status_code == 422


# ---------------------------------------------------------------- PATCH: стадия и заметка


def test_patch_stage_writes_event_and_audit(ctx: Ctx) -> None:
    owner = login_owner(ctx)
    cid = add_company(ctx)
    ctx.clock.advance(60)
    r = owner.patch(f"{API}/{cid}", json={"stage": "contacted"}, headers=ctx.csrf(owner))
    assert r.status_code == 200
    body = r.json()
    assert body["stage"] == "contacted" and body["display"]["key"] == "contacted"
    assert body["history"][0]["title"] == "Стадия изменена"
    assert body["history"][0]["text"] == "Новая стадия: contacted"
    with ctx.db() as db:
        ev = db.scalar(
            select(ActivityEvent).where(ActivityEvent.event_type == "company.stage_changed")
        )
        assert ev is not None and ev.payload_redacted == {"from": "new", "to": "contacted"}
        assert ev.actor_id == ctx.user("owner@example.com").id
        au = db.scalar(select(AuditLog).where(AuditLog.action == "company.stage"))
        assert au is not None and au.entity_id == str(cid)
        assert au.meta == {"from": "new", "to": "contacted"}
        c = db.get(Company, cid)
        assert c is not None and c.updated_at > c.created_at


def test_patch_same_stage_is_noop(ctx: Ctx) -> None:
    owner = login_owner(ctx)
    cid = add_company(ctx)
    r = owner.patch(f"{API}/{cid}", json={"stage": "new"}, headers=ctx.csrf(owner))
    assert r.status_code == 200
    with ctx.db() as db:
        assert db.scalars(select(ActivityEvent)).all() == []
        assert db.scalars(select(AuditLog).where(AuditLog.action == "company.stage")).all() == []


def test_optimistic_stage_conflict(ctx: Ctx) -> None:
    owner = login_owner(ctx)
    cid = add_company(ctx)
    ok = owner.patch(
        f"{API}/{cid}",
        json={"stage": "contacted", "expected_stage": "new"},
        headers=ctx.csrf(owner),
    )
    assert ok.status_code == 200
    # Второй пользователь ещё видит «new» и пытается перевести дальше.
    stale = owner.patch(
        f"{API}/{cid}",
        json={"stage": "replied", "expected_stage": "new"},
        headers=ctx.csrf(owner),
    )
    assert stale.status_code == 409
    assert stale.json()["code"] == "STAGE_CONFLICT" and stale.json()["current_stage"] == "contacted"
    with ctx.db() as db:
        c = db.get(Company, cid)
        assert c is not None and c.stage == "contacted"
        assert len(db.scalars(select(ActivityEvent)).all()) == 1


def test_stage_change_is_compare_and_set(ctx: Ctx) -> None:
    """Устаревший объект (другая сессия успела сменить стадию) не затирает чужое изменение."""
    cid = add_company(ctx)
    uid = uuid.uuid4()
    with ctx.db() as a, ctx.db() as b:
        stale = a.get(Company, cid)
        fresh = b.get(Company, cid)
        assert stale is not None and fresh is not None
        svc.change_stage(b, fresh, "interested", None, uid)
        b.commit()
        with pytest.raises(AppError) as exc:
            svc.change_stage(a, stale, "contacted", None, uid)
        assert exc.value.code == "STAGE_CONFLICT"
    with ctx.db() as db:
        c = db.get(Company, cid)
        assert c is not None and c.stage == "interested"


def test_lost_is_permanent_and_lowers_score(ctx: Ctx) -> None:
    owner = login_owner(ctx)
    post_import(ctx, owner, csv_text("Север;Казань;;;Автосервис"), dry_run=False)
    cid = ctx.client.get(API).json()["items"][0]["id"]
    assert ctx.client.get(f"{API}/{cid}").json()["score"] == 35
    r = owner.patch(f"{API}/{cid}", json={"stage": "lost"}, headers=ctx.csrf(owner))
    body = r.json()
    assert r.status_code == 200 and body["score"] == 25 and body["display"]["key"] == "refused"
    clean = next(x for x in body["score_reasons"] if x["rule"] == "clean")
    assert clean["points"] == 0 and clean["note"] == "Есть отказ"
    assert any(h["event_type"] == "company.score_recalculated" for h in body["history"])
    back = owner.patch(f"{API}/{cid}", json={"stage": "new"}, headers=ctx.csrf(owner))
    assert back.status_code == 409 and back.json()["code"] == "SUPPRESSION_PERMANENT"
    again = owner.patch(f"{API}/{cid}", json={"stage": "lost"}, headers=ctx.csrf(owner))
    assert again.status_code == 200


def test_patch_note_limit_and_privacy(ctx: Ctx) -> None:
    owner = login_owner(ctx)
    cid = add_company(ctx)
    secret = "секретная заметка про клиента"
    ok = owner.patch(f"{API}/{cid}", json={"note": secret}, headers=ctx.csrf(owner))
    assert ok.status_code == 200 and ok.json()["note"] == secret
    assert ok.json()["history"][0]["title"] == "Заметка обновлена"
    full = owner.patch(f"{API}/{cid}", json={"note": "я" * 2000}, headers=ctx.csrf(owner))
    assert full.status_code == 200 and len(full.json()["note"]) == 2000
    over = owner.patch(f"{API}/{cid}", json={"note": "я" * 2001}, headers=ctx.csrf(owner))
    assert over.status_code == 422
    cleared = owner.patch(f"{API}/{cid}", json={"note": ""}, headers=ctx.csrf(owner))
    assert cleared.status_code == 200 and cleared.json()["note"] == ""
    with ctx.db() as db:
        dumped = [str(a.meta) for a in db.scalars(select(AuditLog))]
        dumped += [str(e.payload_redacted) for e in db.scalars(select(ActivityEvent))]
    assert not any(secret in d for d in dumped)


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"stage": "unknown"},
        {"expected_stage": "new"},
        {"stage": "new", "extra": 1},
        {"note": None},
        {"note": 5},
    ],
)
def test_patch_validation(ctx: Ctx, body: dict[str, Any]) -> None:
    owner = login_owner(ctx)
    cid = add_company(ctx)
    r = owner.patch(f"{API}/{cid}", json=body, headers=ctx.csrf(owner))
    assert r.status_code == 422 and r.json()["code"] == "VALIDATION_ERROR"


def test_patch_404(ctx: Ctx) -> None:
    owner = login_owner(ctx)
    r = owner.patch(f"{API}/{uuid.uuid4()}", json={"stage": "lost"}, headers=ctx.csrf(owner))
    assert r.status_code == 404


def test_patch_stage_and_note_together(ctx: Ctx) -> None:
    owner = login_owner(ctx)
    cid = add_company(ctx)
    r = owner.patch(
        f"{API}/{cid}", json={"stage": "interested", "note": "позвонить"}, headers=ctx.csrf(owner)
    )
    assert r.status_code == 200
    assert (r.json()["stage"], r.json()["note"]) == ("interested", "позвонить")


# ---------------------------------------------------------------- reject


def test_reject(ctx: Ctx) -> None:
    owner = login_owner(ctx)
    cid = add_company(ctx)
    r = owner.post(f"{API}/{cid}/reject", headers=ctx.csrf(owner))
    assert r.status_code == 200
    body = r.json()
    assert body["state"] == "rejected" and body["display"]["key"] == "rejected"
    assert body["history"][0]["title"] == "Компания отклонена"
    again = owner.post(f"{API}/{cid}/reject", headers=ctx.csrf(owner))
    assert again.status_code == 200
    with ctx.db() as db:
        events = db.scalars(
            select(ActivityEvent).where(ActivityEvent.event_type == "company.rejected")
        ).all()
        audits = db.scalars(select(AuditLog).where(AuditLog.action == "company.reject")).all()
    assert len(events) == 1 and len(audits) == 1  # повтор идемпотентен


def test_reject_archived_conflict_and_404(ctx: Ctx) -> None:
    owner = login_owner(ctx)
    cid = add_company(ctx, state="archived")
    r = owner.post(f"{API}/{cid}/reject", headers=ctx.csrf(owner))
    assert r.status_code == 409 and r.json()["code"] == "INVALID_STATE"
    assert owner.post(f"{API}/{uuid.uuid4()}/reject", headers=ctx.csrf(owner)).status_code == 404


# ---------------------------------------------------------------- экспорт CSV


def test_export_csv_format_and_injection(ctx: Ctx) -> None:
    login_owner(ctx)
    add_company(
        ctx, '=HYPERLINK("http://evil")', "Казань", category="+cmd", domain="a.example", score=80
    )
    add_company(ctx, "@SUM(1)", "Уфа", category='Кавычки " внутри', score=70)
    add_company(ctx, "-2+3", "Омск", score=60)
    r = ctx.client.get(f"{API}/export")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    assert 'attachment; filename="companies.csv"' in r.headers["content-disposition"]
    text = r.content.decode("utf-8")
    assert text.startswith("﻿" + EXPORT_HEADER)
    lines = text.split("\r\n")
    assert len(lines) == 4
    assert lines[1] == '"\'=HYPERLINK(""http://evil"")";"Казань";"\'+cmd";"a.example";"80";"Новый"'
    assert lines[2].startswith('"\'@SUM(1)";"Уфа";"Кавычки "" внутри"')
    assert lines[3].startswith('"\'-2+3"')
    for line in lines[1:]:  # ни одна ячейка не начинается с опасного символа
        for cell in line.split('";"'):
            assert not cell.lstrip('"').startswith(("=", "+", "-", "@", "\t", "\r"))
    expected = to_csv(
        [
            ["Компания", "Город", "Категория", "Сайт", "Оценка", "Статус"],
            ['=HYPERLINK("http://evil")', "Казань", "+cmd", "a.example", 80, "Новый"],
            ["@SUM(1)", "Уфа", 'Кавычки " внутри', "", 70, "Новый"],
            ["-2+3", "Омск", "Автосервис", "", 60, "Новый"],
        ]
    )
    assert text == expected


def test_export_respects_filters_sort_and_writes_audit(ctx: Ctx) -> None:
    login_owner(ctx)
    add_company(ctx, "Казань 1", "Казань", score=90)
    add_company(ctx, "Казань 2", "Казань", score=60)
    add_company(ctx, "Уфа 1", "Уфа", score=99)
    r = ctx.client.get(f"{API}/export", params={"city": "Казань", "sort": "score", "dir": "asc"})
    rows = r.content.decode().split("\r\n")[1:]
    assert [x.split(";")[0] for x in rows] == ['"Казань 2"', '"Казань 1"']
    with ctx.db() as db:
        au = db.scalar(select(AuditLog).where(AuditLog.action == "company.export"))
    assert au is not None and au.meta is not None and au.meta["city"] == "Казань"
    assert ctx.client.get(f"{API}/export", params={"status": "weird"}).status_code == 422


def test_export_streams_more_than_one_page(ctx: Ctx) -> None:
    login_owner(ctx)
    now = datetime(2026, 11, 10, tzinfo=UTC)
    with ctx.db() as db:
        for i in range(1203):
            db.add(
                Company(
                    name=f"Массовая {i}",
                    normalized_name=f"массовая {i}",
                    city="Казань",
                    city_norm="казань",
                    category="Автосервис",
                    source_label="Тест",
                    score=i % 7,
                    search_text="x",
                    created_at=now,
                    updated_at=now,
                )
            )
        db.commit()
    rows = ctx.client.get(f"{API}/export").content.decode().split("\r\n")
    assert len(rows) == 1 + 1203
    assert len({x.split(";")[0] for x in rows[1:]}) == 1203


# ---------------------------------------------------------------- дашборд


def test_dashboard_empty_is_zeros_not_invented(ctx: Ctx) -> None:
    login_owner(ctx)
    d = ctx.client.get("/api/v1/dashboard").json()
    assert d["companies_total"] == d["companies_week"] == d["suitable"] == 0
    assert d["score_threshold"] == 75
    assert d["by_stage"] == dict.fromkeys(CRM_STAGES, 0)
    assert d["by_state"] == dict.fromkeys(COMPANY_STATES, 0)
    assert d["top_companies"] == [] and d["recent"] == []


def test_dashboard_counts_come_from_db(ctx: Ctx) -> None:
    login_owner(ctx)
    now = ctx.clock.now()
    add_company(ctx, "Новая 1", score=90, created_at=now - timedelta(days=1))
    add_company(ctx, "Новая 2", score=75, created_at=now - timedelta(days=6, hours=23))
    add_company(ctx, "Старая", score=80, created_at=now - timedelta(days=8), stage="contacted")
    add_company(ctx, "Ниже порога", score=74, created_at=now - timedelta(days=2), stage="pilot")
    add_company(ctx, "Отклонена", score=99, state="rejected", created_at=now)
    add_company(ctx, "Отказ", score=99, stage="lost", created_at=now)
    d = ctx.client.get("/api/v1/dashboard").json()
    assert d["companies_total"] == 6
    assert d["companies_week"] == 5  # всё, кроме «Старой»
    assert d["suitable"] == 3  # 90, 75, 80; отклонённые и отказ не считаются
    assert d["by_stage"] == {
        "new": 3,
        "contacted": 1,
        "replied": 0,
        "interested": 0,
        "pilot": 1,
        "lost": 1,
    }
    assert d["by_state"]["rejected"] == 1 and d["by_state"]["discovered"] == 5
    assert [c["name"] for c in d["top_companies"]] == [
        "Новая 1",
        "Старая",
        "Новая 2",
        "Ниже порога",
    ]


def test_dashboard_updates_after_import_and_reject(ctx: Ctx) -> None:
    owner = login_owner(ctx)
    post_import(ctx, owner, csv_text("А;Казань;;;Автосервис", "Б;Уфа;;;Кофейня"), dry_run=False)
    d = ctx.client.get("/api/v1/dashboard").json()
    assert d["companies_total"] == 2 and d["companies_week"] == 2 and d["suitable"] == 0
    assert d["by_stage"]["new"] == 2
    assert [e["title"] for e in d["recent"]] == ["Импортирована из CSV"] * 2
    assert {e["company_name"] for e in d["recent"]} == {"А", "Б"}
    cid = d["top_companies"][0]["id"]
    ctx.clock.advance(60)  # часы в тестах заморожены: событие отклонения должно быть позже импорта
    owner.post(f"{API}/{cid}/reject", headers=ctx.csrf(owner))
    d2 = ctx.client.get("/api/v1/dashboard").json()
    assert d2["by_state"]["rejected"] == 1 and len(d2["top_companies"]) == 1
    assert d2["recent"][0]["title"] == "Компания отклонена"


def test_dashboard_threshold_is_configurable(make_ctx: Callable[..., Ctx]) -> None:
    ctx = make_ctx(score_threshold=40)
    login_owner(ctx)
    add_company(ctx, "А", score=40)
    add_company(ctx, "Б", score=39)
    d = ctx.client.get("/api/v1/dashboard").json()
    assert d["score_threshold"] == 40 and d["suitable"] == 1


def test_threshold_default_and_bounds() -> None:
    assert Settings(secret_key="x" * 32).score_threshold == 75
    with pytest.raises(ValueError, match="score_threshold"):
        Settings(secret_key="x" * 32, score_threshold=101)


# ---------------------------------------------------------------- модели и ограничения БД


@pytest.mark.parametrize("state", COMPANY_STATES)
@pytest.mark.parametrize("stage", CRM_STAGES)
def test_display_key_python_matches_sql(ctx: Ctx, state: str, stage: str) -> None:
    cid = add_company(ctx, state=state, stage=stage)
    with ctx.db() as db:
        sql_key = db.scalar(select(svc.display_key_expr()).where(Company.id == cid))
    assert sql_key == svc.display_key(state, stage)
    assert svc.display_key(state, stage) in svc.DISPLAY


def test_unique_inn_only_when_not_null(ctx: Ctx) -> None:
    add_company(ctx, "Без ИНН 1")
    add_company(ctx, "Без ИНН 2")
    add_company(ctx, "С ИНН", inn="7707083893")
    with pytest.raises(IntegrityError):
        add_company(ctx, "Дубль ИНН", inn="7707083893")


def test_domain_is_not_globally_unique(ctx: Ctx) -> None:
    add_company(ctx, "Филиал 1", "Казань", domain="net.example")
    add_company(ctx, "Филиал 2", "Уфа", domain="net.example")


@pytest.mark.parametrize(
    "kwargs", [{"state": "bogus"}, {"stage": "bogus"}, {"score": 101}, {"score": -1}]
)
def test_db_rejects_invalid_state_stage_score(ctx: Ctx, kwargs: dict[str, Any]) -> None:
    with pytest.raises(IntegrityError):
        add_company(ctx, **kwargs)


def test_fact_requires_evidence_when_confirmed(ctx: Ctx) -> None:
    cid = add_company(ctx)
    add_fact(ctx, cid, kind="hypothesis", url=None, excerpt=None)
    with pytest.raises(IntegrityError):
        add_fact(ctx, cid, kind="confirmed", url=None, excerpt="только выдержка")
    with pytest.raises(IntegrityError):
        add_fact(ctx, cid, kind="confirmed", confidence=1.5)
    with pytest.raises(IntegrityError):
        add_fact(ctx, cid, kind="rumor")


def test_activity_events_are_append_only(ctx: Ctx) -> None:
    owner = login_owner(ctx)
    cid = add_company(ctx)
    owner.patch(f"{API}/{cid}", json={"note": "x"}, headers=ctx.csrf(owner))
    with ctx.db() as db:
        ev = db.scalar(select(ActivityEvent))
        assert ev is not None
        ev.event_type = "tampered"
        with pytest.raises(RuntimeError, match="append-only"):
            db.commit()
        db.rollback()
        db.delete(ev)
        with pytest.raises(RuntimeError, match="append-only"):
            db.commit()
        db.rollback()
    with ctx.db() as db:
        ev2 = db.scalar(select(ActivityEvent))
        assert ev2 is not None and ev2.event_type == "company.note_updated"


def test_one_lead_score_per_company(ctx: Ctx) -> None:
    cid = add_company(ctx)
    with ctx.db() as db:
        db.add(LeadScore(company_id=cid, score=1, rule_version="x", reasons=[], inputs={}))
        with pytest.raises(IntegrityError):
            db.commit()


def test_child_tables_cascade_on_company_delete() -> None:
    fks = {
        (t.name, fk.column.table.name, fk.ondelete)
        for t in (CompanyFact.__table__, LeadScore.__table__, ActivityEvent.__table__)
        for fk in t.foreign_keys
    }
    assert fks == {
        ("company_facts", "companies", "CASCADE"),
        ("lead_scores", "companies", "CASCADE"),
        ("activity_events", "companies", "CASCADE"),
    }
