"""API: проверка сайта, очередь задач, кампании, реестр источников."""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from sqlalchemy import select

from app.models import ActivityEvent, AuditLog, Campaign, Job
from app.services import jobs
from tests.conftest import Ctx
from tests.helpers import add_company, login_active_user, login_owner, login_pending


def audit_actions(ctx: Ctx) -> list[str]:
    with ctx.db() as db:
        return [a.action for a in db.scalars(select(AuditLog).order_by(AuditLog.created_at))]


def mark_checked(ctx: Ctx, cid: uuid.UUID) -> None:
    with ctx.db() as db:
        db.add(
            ActivityEvent(company_id=cid, event_type="company.site_checked", payload_redacted={})
        )
        db.commit()


# --- POST /companies/{id}/enrich ---------------------------------------------------------------


def test_enrich_enqueues_job(ctx: Ctx) -> None:
    c = login_owner(ctx)
    cid = add_company(ctx, domain="sever.example")
    r = c.post(f"/api/v1/companies/{cid}/enrich", headers=ctx.csrf(c))
    assert r.status_code == 202, r.text
    job_id = r.json()["job_id"]
    body = c.get(f"/api/v1/jobs/{job_id}").json()
    assert body["state"] == "queued" and body["type"] == "enrich_company"
    assert body["company_id"] == str(cid) and body["attempts"] == 0 and body["max_attempts"] == 3
    assert "company.enrich" in audit_actions(ctx)


def test_enrich_second_request_conflicts_while_active(ctx: Ctx) -> None:
    c = login_owner(ctx)
    cid = add_company(ctx, domain="sever.example")
    first = c.post(f"/api/v1/companies/{cid}/enrich", headers=ctx.csrf(c)).json()["job_id"]
    r = c.post(f"/api/v1/companies/{cid}/enrich", headers=ctx.csrf(c))
    assert r.status_code == 409 and r.json()["code"] == "JOB_ALREADY_ACTIVE"
    assert r.json()["job_id"] == first
    c.post(f"/api/v1/jobs/{first}/cancel", headers=ctx.csrf(c))
    assert c.post(f"/api/v1/companies/{cid}/enrich", headers=ctx.csrf(c)).status_code == 202


def test_enrich_without_website_is_422(ctx: Ctx) -> None:
    c = login_owner(ctx)
    cid = add_company(ctx)
    r = c.post(f"/api/v1/companies/{cid}/enrich", headers=ctx.csrf(c))
    assert r.status_code == 422 and r.json()["code"] == "NO_WEBSITE"


def test_enrich_unknown_company_404(ctx: Ctx) -> None:
    c = login_owner(ctx)
    assert (
        c.post(f"/api/v1/companies/{uuid.uuid4()}/enrich", headers=ctx.csrf(c)).status_code == 404
    )


def test_enrich_requires_auth_active_and_csrf(ctx: Ctx) -> None:
    owner = login_owner(ctx)
    cid = add_company(ctx, domain="sever.example")
    url = f"/api/v1/companies/{cid}/enrich"
    assert ctx.new_client().post(url).status_code == 401
    assert owner.post(url).status_code == 403  # без CSRF
    pending = login_pending(ctx)
    assert pending.post(url, headers=ctx.csrf(pending)).status_code == 403
    active = login_active_user(ctx, owner, "bob@example.com")
    assert active.post(url, headers=ctx.csrf(active)).status_code == 202


# --- /jobs --------------------------------------------------------------------------------------------


def test_jobs_list_filters_and_cursor(ctx: Ctx) -> None:
    c = login_owner(ctx)
    ids = []
    for i in range(5):
        cid = add_company(ctx, f"К{i}", domain=f"s{i}.example")
        ids.append(c.post(f"/api/v1/companies/{cid}/enrich", headers=ctx.csrf(c)).json()["job_id"])
    c.post(f"/api/v1/jobs/{ids[0]}/cancel", headers=ctx.csrf(c))
    r = c.get("/api/v1/jobs", params={"limit": 2}).json()
    assert len(r["items"]) == 2 and r["has_more"] and r["next_cursor"]
    seen = [j["id"] for j in r["items"]]
    cursor = r["next_cursor"]
    while cursor:
        page = c.get("/api/v1/jobs", params={"limit": 2, "cursor": cursor}).json()
        seen += [j["id"] for j in page["items"]]
        cursor = page["next_cursor"]
    assert sorted(seen) == sorted(ids)
    assert len(c.get("/api/v1/jobs", params={"state": "queued"}).json()["items"]) == 4
    assert len(c.get("/api/v1/jobs", params={"state": "cancelled"}).json()["items"]) == 1
    assert c.get("/api/v1/jobs", params={"type": "nope"}).json()["items"] == []
    assert c.get("/api/v1/jobs", params={"state": "bogus"}).status_code == 422
    assert c.get("/api/v1/jobs", params={"cursor": "###"}).status_code == 422


def test_jobs_require_active_user(ctx: Ctx) -> None:
    assert ctx.new_client().get("/api/v1/jobs").status_code == 401
    assert login_pending(ctx).get("/api/v1/jobs").status_code == 403


def test_job_get_unknown_404(ctx: Ctx) -> None:
    c = login_owner(ctx)
    assert c.get(f"/api/v1/jobs/{uuid.uuid4()}").status_code == 404


def test_cancel_queued_then_conflict_when_finished(ctx: Ctx) -> None:
    c = login_owner(ctx)
    cid = add_company(ctx, domain="sever.example")
    job_id = c.post(f"/api/v1/companies/{cid}/enrich", headers=ctx.csrf(c)).json()["job_id"]
    assert c.post(f"/api/v1/jobs/{job_id}/cancel").status_code == 403  # CSRF
    r = c.post(f"/api/v1/jobs/{job_id}/cancel", headers=ctx.csrf(c))
    assert r.status_code == 200 and r.json()["state"] == "cancelled"
    again = c.post(f"/api/v1/jobs/{job_id}/cancel", headers=ctx.csrf(c))
    assert again.status_code == 409 and again.json()["state"] == "cancelled"
    assert "job.cancel" in audit_actions(ctx)


def test_cancel_running_job_sets_flag(ctx: Ctx) -> None:
    c = login_owner(ctx)
    cid = add_company(ctx, domain="sever.example")
    job_id = c.post(f"/api/v1/companies/{cid}/enrich", headers=ctx.csrf(c)).json()["job_id"]
    with ctx.db() as db:
        assert jobs.claim(db, "w", lock_timeout=300) is not None
    r = c.post(f"/api/v1/jobs/{job_id}/cancel", headers=ctx.csrf(c))
    assert r.status_code == 200 and r.json()["state"] == "running" and r.json()["cancel_requested"]


def test_job_output_fields(ctx: Ctx) -> None:
    c = login_owner(ctx)
    cid = add_company(ctx, domain="sever.example")
    c.post(f"/api/v1/companies/{cid}/enrich", headers=ctx.csrf(c))
    item = c.get("/api/v1/jobs").json()["items"][0]
    assert set(item) == {
        "id", "type", "state", "attempts", "max_attempts", "run_after", "created_at",
        "updated_at", "cancel_requested", "company_id", "campaign_id", "last_error", "result",
    }  # fmt: skip


# --- /campaigns ---------------------------------------------------------------------------------------


def create_campaign(ctx: Ctx, c: Any, **body: Any) -> Any:
    payload = {"name": "Казань", "regions": ["Казань"], "categories": ["автосервис"],
               "filter": {"score_min": 0}, "per_day_limit": 10, **body}  # fmt: skip
    return c.post("/api/v1/campaigns", json=payload, headers=ctx.csrf(c))


def test_campaign_create_get_list(ctx: Ctx) -> None:
    c = login_owner(ctx)
    r = create_campaign(ctx, c)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["status"] == "running" and body["per_day_limit"] == 10
    assert body["regions"] == ["Казань"] and body["filter"] == {"score_min": 0}
    assert body["progress"] == {
        "enqueued_total": 0, "enqueued_today": 0, "last_run_at": None, "jobs": {},
    }  # fmt: skip
    assert c.get(f"/api/v1/campaigns/{body['id']}").json()["id"] == body["id"]
    assert [x["id"] for x in c.get("/api/v1/campaigns").json()["items"]] == [body["id"]]
    assert "campaign.create" in audit_actions(ctx)


@pytest.mark.parametrize(
    "bad",
    [{"name": ""}, {"name": "x" * 121}, {"per_day_limit": 0}, {"per_day_limit": 1001},
     {"filter": {"score_min": 101}}, {"filter": {"unknown": 1}}, {"regions": [""]}, {"extra": 1}],
)  # fmt: skip
def test_campaign_validation(ctx: Ctx, bad: dict[str, Any]) -> None:
    c = login_owner(ctx)
    assert create_campaign(ctx, c, **bad).status_code == 422


def test_campaign_requires_csrf_and_active_user(ctx: Ctx) -> None:
    c = login_owner(ctx)
    assert c.post("/api/v1/campaigns", json={"name": "x"}).status_code == 403
    assert ctx.new_client().get("/api/v1/campaigns").status_code == 401
    assert login_pending(ctx).get("/api/v1/campaigns").status_code == 403


def test_campaign_pause_resume(ctx: Ctx) -> None:
    c = login_owner(ctx)
    cid = create_campaign(ctx, c).json()["id"]
    r = c.patch(f"/api/v1/campaigns/{cid}", json={"status": "paused"}, headers=ctx.csrf(c))
    assert r.json()["status"] == "paused"
    assert c.post(f"/api/v1/campaigns/{cid}/run", headers=ctx.csrf(c)).status_code == 409
    r = c.patch(f"/api/v1/campaigns/{cid}", json={"status": "running"}, headers=ctx.csrf(c))
    assert r.json()["status"] == "running"
    bad = c.patch(f"/api/v1/campaigns/{cid}", json={"status": "done"}, headers=ctx.csrf(c))
    assert bad.status_code == 422
    assert {"campaign.pause", "campaign.resume"} <= set(audit_actions(ctx))
    assert c.get(f"/api/v1/campaigns/{uuid.uuid4()}").status_code == 404


def test_campaign_run_selects_unchecked_matching_companies(ctx: Ctx) -> None:
    c = login_owner(ctx)
    match1 = add_company(ctx, "А", "Казань", domain="a.example", score=60)
    match2 = add_company(ctx, "Б", "г. Казань", domain="b.example", score=40)
    add_company(ctx, "В", "Уфа", domain="c.example")  # другой город
    add_company(ctx, "Г", "Казань", domain="d.example", category="Кафе")  # другая категория
    add_company(ctx, "Д", "Казань")  # нет сайта
    checked = add_company(ctx, "Е", "Казань", domain="e.example", score=70)
    mark_checked(ctx, checked)  # уже проверена
    add_company(ctx, "Ж", "Казань", domain="f.example", state="rejected", score=70)
    add_company(ctx, "З", "Казань", domain="g.example", stage="lost", score=70)
    add_company(ctx, "И", "Казань", domain="h.example", score=10)  # ниже порога
    camp = create_campaign(ctx, c, filter={"score_min": 40}).json()["id"]

    r = c.post(f"/api/v1/campaigns/{camp}/run", headers=ctx.csrf(c))
    assert r.status_code == 200, r.text
    assert r.json() == {
        "enqueued": 2,
        "skipped_active": 0,
        "remaining_today": 8,
        "status": "running",
    }
    with ctx.db() as db:
        rows = list(db.scalars(select(Job)))
        assert {j.payload["company_id"] for j in rows} == {str(match1), str(match2)}
        assert all(j.campaign_id == uuid.UUID(camp) and j.created_by for j in rows)
    assert c.get(f"/api/v1/campaigns/{camp}").json()["progress"]["jobs"] == {"queued": 2}


def test_campaign_run_is_idempotent_no_duplicates(ctx: Ctx) -> None:
    c = login_owner(ctx)
    for i in range(3):
        add_company(ctx, f"К{i}", domain=f"s{i}.example")
    camp = create_campaign(ctx, c).json()["id"]
    assert c.post(f"/api/v1/campaigns/{camp}/run", headers=ctx.csrf(c)).json()["enqueued"] == 3
    second = c.post(f"/api/v1/campaigns/{camp}/run", headers=ctx.csrf(c)).json()
    assert second["enqueued"] == 0 and second["skipped_active"] == 3
    with ctx.db() as db:
        assert len(db.scalars(select(Job)).all()) == 3


def test_campaign_respects_per_day_limit_and_resets_next_day(ctx: Ctx) -> None:
    c = login_owner(ctx)
    for i in range(5):
        add_company(ctx, f"К{i}", domain=f"s{i}.example", score=90 - i)
    camp = create_campaign(ctx, c, per_day_limit=2).json()["id"]
    r1 = c.post(f"/api/v1/campaigns/{camp}/run", headers=ctx.csrf(c)).json()
    assert (r1["enqueued"], r1["remaining_today"]) == (2, 0)
    assert c.post(f"/api/v1/campaigns/{camp}/run", headers=ctx.csrf(c)).json()["enqueued"] == 0
    assert c.get(f"/api/v1/campaigns/{camp}").json()["progress"]["enqueued_today"] == 2
    with ctx.db() as db:  # задачи первого дня завершены (но компании «не проверены»)
        for j in db.scalars(select(Job)):
            j.state = "succeeded"
        db.commit()
    ctx.clock.advance(24 * 3600)
    assert c.post(f"/api/v1/campaigns/{camp}/run", headers=ctx.csrf(c)).json()["enqueued"] == 2


def test_campaign_becomes_done_when_nothing_left(ctx: Ctx) -> None:
    c = login_owner(ctx)
    camp = create_campaign(ctx, c).json()["id"]
    r = c.post(f"/api/v1/campaigns/{camp}/run", headers=ctx.csrf(c)).json()
    assert r["enqueued"] == 0 and r["status"] == "done"
    with ctx.db() as db:
        row = db.get(Campaign, uuid.UUID(camp))
        assert row is not None and row.status == "done"
    assert "campaign.run" in audit_actions(ctx)


# --- /sources --------------------------------------------------------------------------------------------


def test_sources_registry(ctx: Ctx) -> None:
    c = login_owner(ctx)
    items = {s["id"]: s for s in c.get("/api/v1/sources").json()["items"]}
    assert set(items) == {"csv", "public_websites", "catalogs"}
    assert items["csv"]["enabled"] and items["csv"]["retention_days"] == 365
    pw = items["public_websites"]
    assert pw["enabled"] and any("robots" in r for r in pw["rules"])
    cat = items["catalogs"]
    assert cat["enabled"] is False
    assert (
        cat["disabled_reason"] == "Включается только после проверки лицензии и условий источника."
    )


def test_sources_retention_from_settings(make_ctx: Any) -> None:
    ctx = make_ctx(data_retention_days=90)
    c = login_owner(ctx)
    csv = next(s for s in c.get("/api/v1/sources").json()["items"] if s["id"] == "csv")
    assert csv["retention_days"] == 90


def test_sources_require_active_user(ctx: Ctx) -> None:
    assert ctx.new_client().get("/api/v1/sources").status_code == 401
    assert login_pending(ctx).get("/api/v1/sources").status_code == 403
