"""Импорт CSV: dry-run, commit, дедупликация, лимиты, права и CSRF."""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import ActivityEvent, AuditLog, Company, ImportJob, LeadScore
from app.services import companies as svc
from app.services.normalize import ImportRow
from tests.conftest import Ctx
from tests.helpers import (
    add_company,
    count,
    csv_text,
    login_active_user,
    login_owner,
    login_pending,
    post_import,
)

INN_A = "7707083893"
INN_B = "7736207543"


def _commit(ctx: Ctx, text: str) -> dict[str, Any]:
    r = post_import(ctx, ctx.client, text, dry_run=False)
    assert r.status_code == 200, r.text
    body: dict[str, Any] = r.json()
    return body


# ---------------------------------------------------------------- dry-run ничего не пишет


def test_dry_run_returns_rows_and_writes_nothing(ctx: Ctx) -> None:
    login_owner(ctx)
    text = csv_text(
        "Север Авто;Казань;sever.example;;Автосервис",
        ";Уфа;;;",  # ошибка: нет названия
        "Гараж;Тверь;bad host;12;",  # ошибки: сайт и ИНН
    )
    r = post_import(ctx, ctx.client, text, dry_run=True)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["dry_run"] is True and body["missing_columns"] == []
    assert [row["line"] for row in body["rows"]] == [2, 3, 4]
    assert body["rows"][0]["issues"] == [] and body["rows"][0]["website"] == "sever.example"
    assert body["rows"][1]["issues"] == ["Нет названия"]
    assert "Некорректный сайт" in body["rows"][2]["issues"]
    assert body["summary"] == {
        "total": 3,
        "importable": 1,
        "with_issues": 2,
        "exact": 0,
        "in_file": 0,
        "candidates": 0,
    }
    for model in (Company, LeadScore, ImportJob, ActivityEvent):
        assert count(ctx, model) == 0
    with ctx.db() as db:
        actions = [a.action for a in db.scalars(select(AuditLog))]
    assert not any(a.startswith("import.") for a in actions)


def test_dry_run_is_default(ctx: Ctx) -> None:
    login_owner(ctx)
    r = post_import(ctx, ctx.client, csv_text("А;Казань;;;"), dry_run=None)
    assert r.status_code == 200 and r.json()["dry_run"] is True
    assert count(ctx, Company) == 0


def test_dry_run_matches_commit(ctx: Ctx) -> None:
    login_owner(ctx)
    add_company(ctx, "Старый", "Казань", inn=INN_A)
    text = csv_text(
        f"Новый;Москва;novy.example;{INN_B};Шиномонтаж",
        f"Дубль ИНН;Уфа;;{INN_A};",
        "Новый 2;Москва;novy.example;;",
        "Плохой;;;;",
    )
    dry = post_import(ctx, ctx.client, text, dry_run=True).json()
    done = _commit(ctx, text)
    assert done["dry_run"] is False
    assert done["added"] == dry["summary"]["importable"]
    assert done["skipped"] == dry["summary"]["total"] - dry["summary"]["importable"]
    assert done["rows_total"] == dry["summary"]["total"]
    assert done["summary"] == dry["summary"]
    assert count(ctx, Company) == 1 + done["added"]


def test_commit_revalidates_on_server_after_state_changed(ctx: Ctx) -> None:
    """Dry-run сказал «можно», но к commit ИНН уже занят: commit не доверяет прошлой проверке."""
    login_owner(ctx)
    text = csv_text(f"Кто-то;Казань;;{INN_A};")
    assert post_import(ctx, ctx.client, text, dry_run=True).json()["summary"]["importable"] == 1
    add_company(ctx, "Занявший ИНН", "Самара", inn=INN_A)
    res = _commit(ctx, text)
    assert res["added"] == 0 and res["skipped"] == 1
    assert count(ctx, Company) == 1


def test_forged_flags_are_ignored(ctx: Ctx) -> None:
    """У клиента нет канала передать issues/duplicate: JSON с лишними полями отвергается,
    а колонки «issues»/«duplicate» в самом CSV игнорируются."""
    login_owner(ctx)
    forged = {
        "text": csv_text("Кто-то;Казань;;;"),
        "rows": [{"issues": [], "duplicate": None}],
    }
    r = ctx.client.post(
        "/api/v1/imports/companies?dry_run=false", json=forged, headers=ctx.csrf(ctx.client)
    )
    assert r.status_code == 422
    assert count(ctx, Company) == 0
    text = csv_text(
        ";Казань;;;;[];null",
        header="название;город;сайт;инн;категория;issues;duplicate",
    )
    res = _commit(ctx, text)
    assert res["added"] == 0 and res["skipped"] == 1  # нет названия — пропущено


def test_commit_json_body_equivalent_to_csv(ctx: Ctx) -> None:
    login_owner(ctx)
    r = ctx.client.post(
        "/api/v1/imports/companies?dry_run=false",
        json={"text": csv_text("Север;Казань;;;")},
        headers=ctx.csrf(ctx.client),
    )
    assert r.status_code == 200 and r.json()["added"] == 1


# ---------------------------------------------------------------- дедупликация


def test_duplicate_inn_between_imports(ctx: Ctx) -> None:
    login_owner(ctx)
    first = _commit(ctx, csv_text(f"Первая;Казань;;{INN_A};"))
    assert first["added"] == 1
    second = _commit(ctx, csv_text(f"Совсем другое имя;Москва;other.example;{INN_A};"))
    assert second["added"] == 0 and second["skipped"] == 1
    assert count(ctx, Company) == 1
    dry = post_import(ctx, ctx.client, csv_text(f"X;Уфа;;{INN_A};")).json()
    assert dry["rows"][0]["duplicate"] == {"kind": "exact", "of": "Первая"}


def test_same_domain_same_city_is_exact_duplicate(ctx: Ctx) -> None:
    login_owner(ctx)
    _commit(ctx, csv_text("Сеть;Казань;net.example;;"))
    res = _commit(ctx, csv_text("Сеть-2;Казань;https://www.NET.example/page;;"))
    assert res["added"] == 0


def test_branches_of_one_domain_in_different_cities_not_merged(ctx: Ctx) -> None:
    login_owner(ctx)
    res = _commit(ctx, csv_text("Сеть;Казань;net.example;;", "Сеть;Уфа;net.example;;"))
    assert res["added"] == 2
    again = _commit(ctx, csv_text("Сеть;Самара;net.example;;"))
    assert again["added"] == 1
    with ctx.db() as db:
        cities = sorted(db.scalars(select(Company.city)))
    assert cities == ["Казань", "Самара", "Уфа"]


def test_similar_name_is_only_a_candidate(ctx: Ctx) -> None:
    login_owner(ctx)
    _commit(ctx, csv_text("ООО «Мотор»;СПб;;;Автосервис"))
    res = _commit(ctx, csv_text("мотор;Санкт-Петербург;;;Автосервис"))
    assert res["added"] == 1 and res["candidates"] == 1
    with ctx.db() as db:
        rows = db.scalars(select(Company)).all()
        flagged = [c for c in rows if c.duplicate_candidate]
        assert len(rows) == 2 and len(flagged) == 1
        # кандидат теряет 10 баллов «чисто»: автосервис 25+10=35, с пометкой 25
        assert flagged[0].score == 25 and sorted(c.score for c in rows) == [25, 35]
        events = [
            e.event_type
            for e in db.scalars(
                select(ActivityEvent).where(ActivityEvent.company_id == flagged[0].id)
            )
        ]
    assert "company.duplicate_candidate" in events and "company.imported" in events


def test_duplicates_inside_file_are_skipped(ctx: Ctx) -> None:
    login_owner(ctx)
    text = csv_text(
        "А;Уфа;a.example;;",
        "А2;Уфа;a.example;;",
        f"Б;Тверь;;{INN_A};",
        f"В;Омск;;{INN_A};",
    )
    dry = post_import(ctx, ctx.client, text).json()
    kinds = [(r["duplicate"] or {}).get("kind") for r in dry["rows"]]
    assert kinds == [None, "in_file", None, "in_file"]
    assert _commit(ctx, text)["added"] == 2


def test_rows_with_errors_do_not_take_dedup_key(ctx: Ctx) -> None:
    login_owner(ctx)
    res = _commit(ctx, csv_text("Х;Казань;bad host;;", "Х;Казань;;;"))
    assert res["added"] == 1 and res["skipped"] == 1
    with ctx.db() as db:
        assert db.scalar(select(Company.name)) == "Х"


def test_race_on_unique_inn_is_retried(ctx: Ctx, monkeypatch: pytest.MonkeyPatch) -> None:
    """Параллельный импорт успел занять ИНН между проверкой и вставкой: IntegrityError -> повтор."""
    login_owner(ctx)
    add_company(ctx, "Опередивший", "Тверь", inn=INN_A)
    real = svc._load_existing
    calls = {"n": 0}

    def stale(db: Session, rows: list[ImportRow]) -> Any:
        calls["n"] += 1
        return [] if calls["n"] <= 2 else real(db, rows)  # две первые проверки видят «пустую» базу

    monkeypatch.setattr(svc, "_load_existing", stale)
    res = _commit(ctx, csv_text(f"Гонка;Казань;;{INN_A};"))
    assert res["added"] == 0 and res["skipped"] == 1
    assert count(ctx, Company) == 1 and calls["n"] >= 3


# ---------------------------------------------------------------- что записывается


def test_commit_writes_scores_events_audit_and_job(ctx: Ctx) -> None:
    login_owner(ctx)
    res = _commit(ctx, csv_text("Север;Казань;sever.example;;Автосервис", "Кофе;Казань;;;Кофейня"))
    assert res["added"] == 2
    with ctx.db() as db:
        by_name = {c.name: c for c in db.scalars(select(Company))}
        sever, coffee = by_name["Север"], by_name["Кофе"]
        assert (sever.score, coffee.score) == (35, 10)  # 25+10 и 0+10: только известное из файла
        assert sever.source_label == "Импорт CSV" and sever.state == "discovered"
        assert sever.stage == "new" and sever.canonical_domain == "sever.example"
        assert sever.website == "https://sever.example" and sever.demo is False
        ls = db.scalar(select(LeadScore).where(LeadScore.company_id == sever.id))
        assert ls is not None and ls.rule_version == "rules-v1"
        pts = {r["rule"]: r["points"] for r in ls.reasons}
        assert pts == {
            "business_type": 25,
            "demand": 0,
            "site": 0,  # siteWorks=false: сайт не проверялся
            "booking": 0,  # онлайн-запись null: баллов нет
            "contact": 0,
            "clean": 10,
        }
        assert ls.inputs["online_booking_detected"] is None and ls.inputs["site_works"] is False
        booking = next(r for r in ls.reasons if r["rule"] == "booking")
        assert "Не проверялось" in booking["note"]
        job = db.scalar(select(ImportJob))
        assert job is not None
        assert (job.status, job.rows_total, job.rows_added, job.rows_skipped) == (
            "succeeded",
            2,
            2,
            0,
        )
        assert job.user_id == ctx.user("owner@example.com").id and str(job.id) == res["job_id"]
        audit = db.scalar(select(AuditLog).where(AuditLog.action == "import.commit"))
        assert audit is not None and audit.entity_id == str(job.id)
        assert audit.actor_id == job.user_id and audit.meta is not None
        assert audit.meta["added"] == 2
        imported = db.scalars(
            select(ActivityEvent).where(ActivityEvent.event_type == "company.imported")
        ).all()
        assert len(imported) == 2 and imported[0].payload_redacted is not None


def test_import_does_not_store_file_content(ctx: Ctx) -> None:
    """В import_jobs и audit_logs только счётчики; содержимое файла не сохраняется как файл."""
    login_owner(ctx)
    marker = "УНИКАЛЬНАЯ-МЕТКА-ФАЙЛА"
    _commit(ctx, csv_text(f"Север;Казань;;;{marker}"))
    with ctx.db() as db:
        job = db.scalar(select(ImportJob))
        assert job is not None
        dumped = json.dumps(
            {c.name: str(getattr(job, c.name)) for c in ImportJob.__table__.columns}
        )
        audit_meta = [json.dumps(a.meta) for a in db.scalars(select(AuditLog))]
    assert marker not in dumped
    assert not any(marker in m for m in audit_meta)
    assert {c.name for c in ImportJob.__table__.columns} == {
        "id",
        "user_id",
        "status",
        "rows_total",
        "rows_added",
        "rows_skipped",
        "created_at",
    }


# ---------------------------------------------------------------- форматы и лимиты


@pytest.mark.parametrize(
    "text",
    [
        "﻿название;город\r\nСевер;Казань\r\n",
        "name,city\nСевер,Казань\n",
        "название\tгород\nСевер\tКазань\n",
    ],
    ids=["bom-semicolon", "comma", "tab"],
)
def test_delimiters_and_bom(ctx: Ctx, text: str) -> None:
    login_owner(ctx)
    r = post_import(ctx, ctx.client, text, dry_run=False)
    assert r.status_code == 200 and r.json()["added"] == 1


def test_cp1251_body_is_decoded(ctx: Ctx) -> None:
    login_owner(ctx)
    raw = "название;город\r\nСевер Авто;Казань\r\n".encode("cp1251")
    r = post_import(ctx, ctx.client, raw, dry_run=False, content_type="text/csv")
    assert r.status_code == 200 and r.json()["added"] == 1
    with ctx.db() as db:
        assert db.scalar(select(Company.name)) == "Север Авто"


def test_undecodable_body_is_422(ctx: Ctx) -> None:
    login_owner(ctx)
    r = post_import(ctx, ctx.client, b"a;b\n\x98\xff;\x81\n", content_type="text/csv")
    assert r.status_code == 422 and r.json()["code"] == "INVALID_ENCODING"


def test_size_limit_2mb(ctx: Ctx) -> None:
    login_owner(ctx)
    big = b"a;b\n" + b"x" * (svc.MAX_IMPORT_BYTES + 1)
    r = post_import(ctx, ctx.client, big)
    assert r.status_code == 413 and r.json()["code"] == "PAYLOAD_TOO_LARGE"
    j = ctx.client.post(
        "/api/v1/imports/companies",
        json={"text": "x" * (svc.MAX_IMPORT_BYTES + 1)},
        headers=ctx.csrf(ctx.client),
    )
    assert j.status_code == 413
    assert count(ctx, Company) == 0


def test_size_limit_without_content_length(ctx: Ctx) -> None:
    """Chunked-тело без Content-Length тоже ограничивается при чтении потока."""
    login_owner(ctx)

    def gen() -> Iterator[bytes]:
        yield b"a;b\n"
        for _ in range(3):
            yield b"x" * (1024 * 1024)

    r = ctx.client.post(
        "/api/v1/imports/companies",
        content=gen(),
        headers={"Content-Type": "text/csv", **ctx.csrf(ctx.client)},
    )
    assert r.status_code == 413


def test_row_limit_5000(ctx: Ctx) -> None:
    login_owner(ctx)
    rows = [f"Компания {i};Город{i % 50};;;" for i in range(5000)]
    ok = post_import(ctx, ctx.client, csv_text(*rows))
    assert ok.status_code == 200 and ok.json()["summary"]["total"] == 5000
    too_many = post_import(ctx, ctx.client, csv_text(*rows, "Лишняя;Казань;;;"))
    assert too_many.status_code == 422 and too_many.json()["code"] == "TOO_MANY_ROWS"
    assert post_import(ctx, ctx.client, csv_text(*rows), dry_run=False).json()["added"] == 5000
    assert count(ctx, Company) == 5000


def test_empty_file_and_header_only(ctx: Ctx) -> None:
    login_owner(ctx)
    for body in ("", "название;город\r\n"):
        r = post_import(ctx, ctx.client, body)
        assert r.status_code == 422 and r.json()["code"] == "EMPTY_FILE"


def test_missing_columns(ctx: Ctx) -> None:
    login_owner(ctx)
    text = "компания;сайт\r\nСевер;sever.example\r\n"
    dry = post_import(ctx, ctx.client, text).json()
    assert dry["missing_columns"] == ["город"] and dry["rows"] == []
    r = post_import(ctx, ctx.client, text, dry_run=False)
    assert r.status_code == 422 and r.json()["code"] == "MISSING_COLUMNS"
    assert r.json()["missing_columns"] == ["город"]
    assert count(ctx, Company) == 0


def test_unsupported_content_type_and_bad_json(ctx: Ctx) -> None:
    login_owner(ctx)
    assert post_import(ctx, ctx.client, "x", content_type="image/png").status_code == 415
    bad = post_import(ctx, ctx.client, "{not json", content_type="application/json")
    assert bad.status_code == 422
    wrong = post_import(ctx, ctx.client, '{"text": 5}', content_type="application/json")
    assert wrong.status_code == 422


def test_too_long_and_nul_values_are_row_issues(ctx: Ctx) -> None:
    login_owner(ctx)
    text = csv_text(f"{'Я' * 301};Казань;;;", "Нул\x00ь;Казань;;;", "Нормальная;Казань;;;")
    dry = post_import(ctx, ctx.client, text).json()
    assert dry["rows"][0]["issues"] == ["Слишком длинное название"]
    assert dry["rows"][1]["issues"] == ["Недопустимые символы"]
    assert dry["rows"][2]["issues"] == []
    assert _commit(ctx, text)["added"] == 1


def test_default_category_and_city_title_case(ctx: Ctx) -> None:
    login_owner(ctx)
    _commit(ctx, csv_text("Север;г. нижний новгород;;;"))
    with ctx.db() as db:
        c = db.scalar(select(Company))
        assert c is not None and (c.city, c.category) == ("Нижний Новгород", "Автосервис")


# ---------------------------------------------------------------- права доступа и CSRF


def test_import_requires_login(ctx: Ctx) -> None:
    r = ctx.client.post(
        "/api/v1/imports/companies", content=b"a", headers={"Content-Type": "text/csv"}
    )
    assert r.status_code == 401


def test_import_pending_user_forbidden(ctx: Ctx) -> None:
    login_owner(ctx)
    pending = login_pending(ctx)
    r = post_import(ctx, pending, csv_text("А;Казань;;;"), dry_run=False)
    assert r.status_code == 403 and r.json()["code"] == "ACCOUNT_PENDING"
    assert count(ctx, Company) == 0


def test_import_needs_csrf_even_for_dry_run(ctx: Ctx) -> None:
    login_owner(ctx)
    for dry in (True, False):
        r = post_import(ctx, ctx.client, csv_text("А;Казань;;;"), dry_run=dry, csrf=False)
        assert r.status_code == 403 and r.json()["code"] == "CSRF_FAILED"
    assert count(ctx, Company) == 0


def test_active_non_owner_can_import(ctx: Ctx) -> None:
    owner = login_owner(ctx)
    user = login_active_user(ctx, owner)
    r = post_import(ctx, user, csv_text("А;Казань;;;"), dry_run=False)
    assert r.status_code == 200 and r.json()["added"] == 1


def test_blocked_user_loses_import_access(ctx: Ctx) -> None:
    owner = login_owner(ctx)
    user = login_active_user(ctx, owner)
    uid = ctx.user("alice@example.com").id
    blocked = owner.post(f"/api/v1/admin/users/{uid}/block", headers=ctx.csrf(owner))
    assert blocked.status_code == 200
    assert post_import(ctx, user, csv_text("А;Казань;;;"), dry_run=False).status_code == 401


def test_anonymous_gets_401_before_body_is_read(ctx: Ctx) -> None:
    big = b"x" * (svc.MAX_IMPORT_BYTES + 10)
    r = ctx.client.post(
        "/api/v1/imports/companies", content=big, headers={"Content-Type": "text/csv"}
    )
    assert r.status_code == 401


def test_contexts_are_independent(make_ctx: Callable[..., Ctx]) -> None:
    a, b = make_ctx(), make_ctx()
    login_owner(a)
    assert post_import(a, a.client, csv_text("А;Казань;;;"), dry_run=False).json()["added"] == 1
    assert count(b, Company) == 0
