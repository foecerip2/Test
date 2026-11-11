"""Проверка сайта: факты с доказательствами, пересчёт оценки, замена фактов, защита от вредного текста."""

from __future__ import annotations

import logging
import re
import uuid
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from sqlalchemy import select

from app.models import ActivityEvent, Company, CompanyFact, LeadScore
from app.services.enrichment import (
    EnrichmentResult,
    inspect_site,
    make_fact,
    pick_internal_pages,
    run_enrichment,
)
from app.services.jobs import JobCancelled, PermanentError, RetryableError
from app.services.safe_fetch import DomainThrottle, FetchError, SafeFetcher
from app.services.scoring import ScoreInput, score_company
from tests.conftest import Ctx
from tests.helpers import add_company, add_fact
from tests.netutil import LocalSite, Resp

SITES = Path(__file__).parent / "fixtures" / "sites"
HTML_TYPE = "text/html; charset=utf-8"


def fx(name: str) -> bytes:
    return (SITES / name).read_bytes()


def page(name: str) -> Resp:
    return Resp(body=fx(name))


def text_page(body: str) -> Resp:
    return Resp(body=f"<html><head><title>t</title></head><body>{body}</body></html>".encode())


@pytest.fixture
def site() -> Iterator[LocalSite]:
    with LocalSite({"/robots.txt": Resp(status=404)}) as s:
        yield s


def fetcher_for(site: LocalSite, **kw: object) -> SafeFetcher:
    return SafeFetcher(
        allow_private=True,
        allowed_ports=frozenset({site.port}),
        resolver=lambda h: ["127.0.0.1"],
        throttle=DomainThrottle(0),
        **kw,  # type: ignore[arg-type]
    )


def make_company(
    ctx: Ctx, site: LocalSite, *, category: str = "Автосервис", **kw: object
) -> uuid.UUID:
    cid = add_company(ctx, "Север Авто", "Казань", category=category, domain="site.test", **kw)  # type: ignore[arg-type]
    with ctx.db() as db:
        c = db.get(Company, cid)
        assert c is not None
        c.website = f"http://site.test:{site.port}"
        db.commit()
    return cid


def enrich(
    ctx: Ctx,
    site: LocalSite,
    cid: uuid.UUID,
    *,
    check: Callable[[], None] = lambda: None,
    last_attempt: bool = False,
    fetcher: SafeFetcher | None = None,
) -> EnrichmentResult:
    return run_enrichment(
        ctx.app.state.session_factory,
        fetcher or fetcher_for(site),
        cid,
        check,
        last_attempt=last_attempt,
    )


def facts(ctx: Ctx, cid: uuid.UUID) -> list[CompanyFact]:
    with ctx.db() as db:
        return list(db.scalars(select(CompanyFact).where(CompanyFact.company_id == cid)))


def by_key(rows: list[CompanyFact]) -> dict[str, CompanyFact]:
    return {r.fact_key or "": r for r in rows}


def events(ctx: Ctx, cid: uuid.UUID, kind: str) -> list[ActivityEvent]:
    with ctx.db() as db:
        return list(
            db.scalars(
                select(ActivityEvent).where(
                    ActivityEvent.company_id == cid, ActivityEvent.event_type == kind
                )
            )
        )


def company(ctx: Ctx, cid: uuid.UUID) -> Company:
    with ctx.db() as db:
        c = db.get(Company, cid)
        assert c is not None
        return c


def lead(ctx: Ctx, cid: uuid.UUID) -> LeadScore:
    with ctx.db() as db:
        ls = db.scalar(select(LeadScore).where(LeadScore.company_id == cid))
        assert ls is not None
        return ls


def rich_site(site: LocalSite) -> None:
    site.routes.update(
        {
            "/": page("good.html"),
            "/uslugi": page("prices.html"),
            "/kontakty": page("contacts.html"),
            "/zapis": text_page(
                "Запись на сервис: выберите удобное время визита для вашего автомобиля."
            ),
        }
    )


# --- основной сценарий ------------------------------------------------------------------------------------------


def test_rich_site_facts_with_evidence_and_rescoring(ctx: Ctx, site: LocalSite) -> None:
    rich_site(site)
    cid = make_company(ctx, site)
    assert company(ctx, cid).score == 35

    res = enrich(ctx, site, cid)

    assert (
        res.outcome == "checked" and res.pages_checked == 4
    )  # главная + /uslugi, /kontakty, /zapis
    assert res.site_works and res.online_booking == "detected" and res.has_business_contact
    assert res.demand_signals == 3
    # 25 (тип) + 20 (3 признака спроса, потолок) + 15 (сайт) + 0 (запись обнаружена) + 15 (контакт) + 10
    assert (res.score_before, res.score_after) == (35, 85)
    c = company(ctx, cid)
    assert c.score == 85 and c.state == "scored"

    ls = lead(ctx, cid)
    assert ls.score == 85 and ls.rule_version == "rules-v1"
    assert sum(r["points"] for r in ls.reasons) == 85
    expected, _ = score_company(ScoreInput(**ls.inputs))
    assert expected == 85
    assert ls.inputs["site_works"] is True and ls.inputs["online_booking_detected"] is True
    assert ls.inputs["demand_signals"] == 3 and ls.inputs["has_business_contact"] is True

    rows = facts(ctx, cid)
    keys = by_key(rows)
    assert {"site", "prices", "hours", "online_booking", "contact:phone", "contact:email"} <= set(
        keys
    )
    assert {"service:диагностика", "service:шиномонтаж", "service:замена масла"} <= set(keys)
    assert all(r.source == "website" for r in rows)
    for r in rows:
        if r.kind == "confirmed":  # confirmed — только с URL и выдержкой ≤200 символов
            assert r.evidence_url and r.evidence_url.startswith(f"http://site.test:{site.port}/")
            assert r.evidence_excerpt and 0 < len(r.evidence_excerpt) <= 200
        assert 0 <= r.confidence <= 1
    assert keys["online_booking"].kind == "confirmed"
    assert keys["prices"].evidence_url.endswith("/") or "/uslugi" in keys["prices"].evidence_url

    checked = events(ctx, cid, "company.site_checked")
    assert len(checked) == 1 and checked[0].payload_redacted["outcome"] == "checked"  # type: ignore[index]
    recalculated = events(ctx, cid, "company.score_recalculated")
    assert [e.payload_redacted for e in recalculated] == [
        {"from": 35, "to": 85, "source": "website_check"}
    ]


def test_no_personal_data_is_stored_or_logged(
    ctx: Ctx, site: LocalSite, caplog: pytest.LogCaptureFixture
) -> None:
    rich_site(site)
    cid = make_company(ctx, site)
    with caplog.at_level(logging.DEBUG):
        enrich(ctx, site, cid)

    blob = " | ".join(f"{f.text} {f.evidence_url} {f.evidence_excerpt}" for f in facts(ctx, cid))
    for e in events(ctx, cid, "company.site_checked") + events(
        ctx, cid, "company.score_recalculated"
    ):
        blob += f" | {e.payload_redacted}"
    blob += " | " + " | ".join(r.getMessage() for r in caplog.records)
    for secret in ("sever-avto.example.com", "info@", "contact@", "0000001", "000-00-0", "(900)"):
        assert secret not in blob, secret
    # ни одного телефона; начало номера не посреди слова/UUID (иначе «…c8-9ab…» даёт ложное срабатывание)
    assert not re.search(r"(?<![\w-])(?:\+7|7|8)[\s(-]*9\d\d[\s)-]*\d", blob)
    contact = by_key(facts(ctx, cid))["contact:phone"]
    assert contact.kind == "confirmed" and "значение не сохранено" in contact.text


def test_site_without_booking_marks_not_detected_as_hypothesis(ctx: Ctx, site: LocalSite) -> None:
    site.routes["/"] = page("no_booking.html")
    cid = make_company(ctx, site)
    res = enrich(ctx, site, cid)
    assert res.online_booking == "not_detected" and res.score_after == 100
    fact = by_key(facts(ctx, cid))["online_booking"]
    assert fact.kind == "hypothesis"  # отсутствие записи — не доказано
    assert "не доказательство" in fact.text and "не обнаружена" in fact.text
    reasons = {r["rule"]: r for r in lead(ctx, cid).reasons}
    assert reasons["booking"]["points"] == 15
    assert "не доказательство" in reasons["booking"]["note"]


def test_widget_site_detects_booking_system_with_evidence(ctx: Ctx, site: LocalSite) -> None:
    site.routes["/"] = page("widget.html")
    cid = make_company(ctx, site)
    res = enrich(ctx, site, cid)
    assert res.online_booking == "detected"
    fact = by_key(facts(ctx, cid))["online_booking"]
    assert fact.kind == "confirmed" and "yclients.com" in (fact.evidence_excerpt or "")
    assert reasons_of(ctx, cid)["booking"]["points"] == 0


def reasons_of(ctx: Ctx, cid: uuid.UUID) -> dict[str, dict[str, object]]:
    return {r["rule"]: r for r in lead(ctx, cid).reasons}


def test_empty_site_is_reachable_but_not_working_and_booking_not_checked(
    ctx: Ctx, site: LocalSite
) -> None:
    site.routes["/"] = page("empty.html")
    cid = make_company(ctx, site)
    res = enrich(ctx, site, cid)
    assert res.outcome == "checked" and res.site_works is False
    assert res.online_booking == "not_checked" and res.score_after == 35
    keys = by_key(facts(ctx, cid))
    assert keys["site"].kind == "hypothesis" and "почти не содержит текста" in keys["site"].text
    assert (
        keys["online_booking"].kind == "hypothesis"
        and "не проверялась" in keys["online_booking"].text
    )
    assert lead(ctx, cid).inputs["online_booking_detected"] is None


def test_frameset_site_follows_frames(ctx: Ctx, site: LocalSite) -> None:
    site.routes.update(
        {
            "/": page("frames.html"),
            "/menu.html": text_page('<a href="/main.html">Главная страница сайта автосервиса</a>'),
            "/main.html": text_page(
                "Шиномонтаж и диагностика. Цены от 900 руб. Работаем ежедневно с 9:00 до 21:00. "
                "Контактный телефон: +7 900 000-00-06."
            ),
        }
    )
    cid = make_company(ctx, site)
    res = enrich(ctx, site, cid)
    assert res.site_works and res.pages_checked == 3
    keys = by_key(facts(ctx, cid))
    assert keys["site"].kind == "hypothesis" and "фрейме" in keys["site"].text
    assert {"service:шиномонтаж", "service:диагностика", "prices", "hours"} <= set(keys)
    assert res.online_booking == "not_detected"


def test_frameset_with_unreadable_frames_leaves_booking_not_checked(
    ctx: Ctx, site: LocalSite
) -> None:
    site.routes["/"] = page("frames.html")  # фреймы отдают 404
    cid = make_company(ctx, site)
    res = enrich(ctx, site, cid)
    assert res.site_works is True and res.online_booking == "not_checked" and res.pages_checked == 1


def test_injection_text_cannot_influence_result(ctx: Ctx, site: LocalSite) -> None:
    site.routes["/"] = page("injection.html")
    cid = make_company(ctx, site)
    res = enrich(ctx, site, cid)
    assert res.score_after != 100 and res.online_booking == "not_detected"
    assert company(ctx, cid).score == res.score_after
    assert (
        events(ctx, cid, "company.site_checked")[0].payload_redacted["suspicious_instructions"]
        is True
    )  # type: ignore[index]
    for f in facts(ctx, cid):
        blob = f"{f.text} {f.evidence_excerpt}".lower()
        assert "ignore" not in blob and "игнорируй" not in blob and "attacker" not in blob


def test_cp1251_site_is_decoded(ctx: Ctx, site: LocalSite) -> None:
    raw = (SITES / "cp1251.src.html").read_text(encoding="utf-8").encode("cp1251")
    site.routes["/"] = Resp(body=raw, content_type="text/html")  # кодировка — только в <meta>
    cid = make_company(ctx, site)
    res = enrich(ctx, site, cid)
    assert res.outcome == "checked" and res.demand_signals == 3
    keys = by_key(facts(ctx, cid))
    assert "иагностик" in (keys["service:диагностика"].evidence_excerpt or "")
    assert "Южный" in (keys["site"].evidence_excerpt or "")


def test_junk_site_never_breaks_enrichment(ctx: Ctx, site: LocalSite) -> None:
    site.routes["/"] = page("junk.html")
    cid = make_company(ctx, site)
    res = enrich(ctx, site, cid)
    assert res.outcome == "checked"
    for f in facts(ctx, cid):
        assert f.kind == "hypothesis" or (f.evidence_url and f.evidence_excerpt)


# --- ошибки загрузки -----------------------------------------------------------------------------------------------------


def test_missing_site_is_unreachable_and_penalised(ctx: Ctx, site: LocalSite) -> None:
    site.routes["/"] = Resp(status=404)
    cid = make_company(ctx, site)
    res = enrich(ctx, site, cid)
    assert res.outcome == "unreachable" and res.site_works is False and res.score_after == 35
    fact = by_key(facts(ctx, cid))["site"]
    assert fact.kind == "hypothesis" and "недоступен" in fact.text
    assert lead(ctx, cid).inputs["site_works"] is False


def test_unreachable_site_lowers_previous_good_score(ctx: Ctx, site: LocalSite) -> None:
    rich_site(site)
    cid = make_company(ctx, site)
    assert enrich(ctx, site, cid).score_after == 85
    site.routes["/"] = Resp(status=404)
    res = enrich(ctx, site, cid)
    assert res.outcome == "unreachable" and res.score_after == 35
    assert "online_booking" not in by_key(facts(ctx, cid))  # старые факты заменены, а не накоплены


def test_transient_error_is_retryable_until_last_attempt(ctx: Ctx, site: LocalSite) -> None:
    site.routes["/"] = Resp(status=503)
    cid = make_company(ctx, site)
    with pytest.raises(RetryableError):
        enrich(ctx, site, cid)
    assert facts(ctx, cid) == [] and company(ctx, cid).score == 35  # ничего не записано
    res = enrich(ctx, site, cid, last_attempt=True)  # попытки закончились — фиксируем «недоступен»
    assert res.outcome == "unreachable"


def test_robots_disallow_skips_site_without_rescoring(ctx: Ctx, site: LocalSite) -> None:
    site.routes["/robots.txt"] = Resp(
        content_type="text/plain", body=b"User-agent: *\nDisallow: /\n"
    )
    site.routes["/"] = page("good.html")
    cid = make_company(ctx, site)
    res = enrich(ctx, site, cid)
    assert res.outcome == "skipped" and res.error_code == "robots_disallowed"
    assert res.score_before == res.score_after == 35
    assert site.paths() == ["/robots.txt"]  # страница не запрашивалась
    fact = by_key(facts(ctx, cid))["site"]
    assert fact.kind == "hypothesis" and "robots.txt" in fact.text
    assert company(ctx, cid).state == "discovered"
    assert events(ctx, cid, "company.score_recalculated") == []
    assert (
        events(ctx, cid, "company.site_checked")[0].payload_redacted["error_code"]
        == "robots_disallowed"
    )  # type: ignore[index]


def test_robots_may_forbid_only_some_internal_pages(ctx: Ctx, site: LocalSite) -> None:
    rich_site(site)
    site.routes["/robots.txt"] = Resp(
        content_type="text/plain", body=b"User-agent: LeadHunterBot\nDisallow: /kontakty\n"
    )
    cid = make_company(ctx, site)
    res = enrich(ctx, site, cid)
    assert res.outcome == "checked" and res.pages_checked == 3
    assert "/kontakty" not in site.paths()
    assert events(ctx, cid, "company.site_checked")[0].payload_redacted["pages_blocked"] == 1  # type: ignore[index]


def test_private_address_site_is_skipped(ctx: Ctx, site: LocalSite) -> None:
    cid = make_company(ctx, site)
    strict = SafeFetcher(resolver=lambda h: ["10.0.0.5"], throttle=DomainThrottle(0))
    with ctx.db() as db:
        c = db.get(Company, cid)
        assert c is not None
        c.website = "https://site.test"
        db.commit()
    res = enrich(ctx, site, cid, fetcher=strict)
    assert res.outcome == "skipped" and res.error_code == "host_blocked"
    assert res.score_after == 35 and site.log == []


def test_redirect_to_other_domain_is_not_used(ctx: Ctx, site: LocalSite) -> None:
    site.routes["/"] = Resp(
        status=302, headers={"Location": f"http://elsewhere.test:{site.port}/x"}, content_type=None
    )
    site.routes["/x"] = page("good.html")
    cid = make_company(ctx, site)
    res = enrich(ctx, site, cid)
    assert res.outcome == "skipped" and res.error_code == "redirect_other_domain"
    assert res.score_after == 35
    assert all(f.kind == "hypothesis" for f in facts(ctx, cid))


def test_www_redirect_on_same_site_is_fine(ctx: Ctx, site: LocalSite) -> None:
    site.routes["/"] = Resp(
        status=301,
        headers={"Location": f"http://www.site.test:{site.port}/home"},
        content_type=None,
    )
    site.routes["/home"] = page("no_booking.html")
    cid = make_company(ctx, site)
    assert enrich(ctx, site, cid).outcome == "checked"


# --- лимиты, отмена, идемпотентность ---------------------------------------------------------------------------------------------


def test_at_most_five_pages_per_domain(ctx: Ctx, site: LocalSite) -> None:
    links = "".join(f'<a href="/uslugi/{i}">Услуги {i}</a>' for i in range(20))
    site.routes["/"] = text_page(links + " Автосервис: диагностика и ремонт, работаем каждый день.")
    site.routes["*"] = text_page("Прайс: диагностика подвески 900 руб. для всех автомобилей.")
    cid = make_company(ctx, site)
    res = enrich(ctx, site, cid)
    pages = [p for p in site.paths() if p != "/robots.txt"]
    assert len(pages) == 5 and res.pages_checked == 5  # главная + 4 внутренние


def test_cancel_between_pages_stops_without_writing(ctx: Ctx, site: LocalSite) -> None:
    rich_site(site)
    cid = make_company(ctx, site)
    calls = {"n": 0}

    def check() -> None:
        calls["n"] += 1
        if calls["n"] >= 3:
            raise JobCancelled("stop")

    with pytest.raises(JobCancelled):
        enrich(ctx, site, cid, check=check)
    assert facts(ctx, cid) == [] and company(ctx, cid).score == 35
    assert events(ctx, cid, "company.site_checked") == []
    assert len([p for p in site.paths() if p != "/robots.txt"]) < 4


def test_rerun_replaces_website_facts_and_keeps_others(ctx: Ctx, site: LocalSite) -> None:
    rich_site(site)
    cid = make_company(ctx, site)
    manual = add_fact(ctx, cid, text="Ручной факт", url="https://example.com/x", excerpt="цитата")
    first = enrich(ctx, site, cid)
    n_first = len(facts(ctx, cid))
    second = enrich(ctx, site, cid)
    rows = facts(ctx, cid)
    assert len(rows) == n_first  # не удвоились
    assert any(r.id == manual for r in rows)  # факты других источников не тронуты
    assert second.score_after == first.score_after
    assert len(events(ctx, cid, "company.site_checked")) == 2
    assert (
        len(events(ctx, cid, "company.score_recalculated")) == 1
    )  # во второй раз оценка не менялась
    keys = [r.fact_key for r in rows if r.source == "website"]
    assert len(keys) == len(set(keys))


def test_site_change_between_checks_updates_facts_and_score(ctx: Ctx, site: LocalSite) -> None:
    site.routes["/"] = page("no_booking.html")
    cid = make_company(ctx, site)
    assert enrich(ctx, site, cid).score_after == 100
    site.routes["/"] = page("widget.html")
    res = enrich(ctx, site, cid)
    assert res.online_booking == "detected" and res.score_after < 100
    keys = by_key(facts(ctx, cid))
    assert keys["online_booking"].kind == "confirmed"
    assert "contact:email" not in keys  # у нового сайта контактов нет
    assert [e.payload_redacted["to"] for e in events(ctx, cid, "company.score_recalculated")][
        -1
    ] == res.score_after  # type: ignore[index]


def test_duplicate_and_refusal_flags_are_preserved(ctx: Ctx, site: LocalSite) -> None:
    site.routes["/"] = page("no_booking.html")
    cid = make_company(ctx, site, stage="lost")
    with ctx.db() as db:
        c = db.get(Company, cid)
        assert c is not None
        c.duplicate_candidate = True
        db.commit()
    enrich(ctx, site, cid)
    assert reasons_of(ctx, cid)["clean"]["points"] == 0
    assert (
        lead(ctx, cid).inputs["has_refusal"] is True
        and lead(ctx, cid).inputs["is_duplicate"] is True
    )


def test_rejected_company_keeps_state(ctx: Ctx, site: LocalSite) -> None:
    site.routes["/"] = page("no_booking.html")
    cid = make_company(ctx, site, state="rejected")
    enrich(ctx, site, cid)
    assert company(ctx, cid).state == "rejected"


def test_company_without_website_is_permanent_error(ctx: Ctx, site: LocalSite) -> None:
    cid = add_company(ctx, "Без сайта", "Казань")
    with pytest.raises(PermanentError):
        enrich(ctx, site, cid)


def test_unknown_company_is_permanent_error(ctx: Ctx, site: LocalSite) -> None:
    with pytest.raises(PermanentError):
        enrich(ctx, site, uuid.uuid4())


def test_company_deleted_during_check_is_permanent_error(ctx: Ctx, site: LocalSite) -> None:
    site.routes["/"] = page("no_booking.html")
    cid = make_company(ctx, site)

    def check() -> None:
        with ctx.db() as db:
            c = db.get(Company, cid)
            if c is not None:
                db.delete(c)
                db.commit()

    with pytest.raises(PermanentError):
        enrich(ctx, site, cid, check=check)


# --- выбор страниц и вспомогательное ------------------------------------------------------------------------------------------------


def test_pick_internal_pages_priority_limit_and_filters() -> None:
    home = "https://site.test/"
    links = [
        ("https://site.test/blog/post-1", "Новость"),  # без ключевых слов — не берём
        ("https://site.test/contacts", "Контакты"),
        ("https://site.test/uslugi/", "Услуги"),
        ("https://site.test/uslugi", "Услуги"),  # дубль по слэшу
        ("https://site.test/online-zapis", "Записаться онлайн"),
        ("https://site.test/price", "Цены"),
        ("https://site.test/remont-dvigatelya", "Ремонт двигателя"),
        ("https://other.example/uslugi", "Чужой сайт"),
        ("https://site.test/", "Главная"),
        ("https://www.site.test/kontakty", "Контакты"),  # www — тот же сайт
    ]
    picked = pick_internal_pages(home, links)
    assert len(picked) == 4
    assert picked[0] == "https://site.test/online-zapis"  # запись — самый высокий приоритет
    assert all("other.example" not in p and "blog" not in p for p in picked)
    assert len({p.rstrip("/") for p in picked}) == 4


def test_pick_internal_pages_frames_first_and_none_without_keywords() -> None:
    home = "https://site.test/"
    picked = pick_internal_pages(
        home, [("https://site.test/a.html", "frame"), ("https://site.test/uslugi", "Услуги")]
    )
    assert picked[0] == "https://site.test/a.html"
    assert (
        pick_internal_pages(home, [("https://site.test/x", "X"), ("https://site.test/y", "Y")])
        == []
    )


def test_make_fact_downgrades_unproven_confirmed() -> None:
    assert make_fact("k", "confirmed", "t", None, "цитата", 0.9).kind == "hypothesis"
    assert (
        make_fact("k", "confirmed", "t", "https://a.example/p?token=1", "", 0.9).kind
        == "hypothesis"
    )
    ok = make_fact(
        "k", "confirmed", "t", "https://a.example/p?token=1#x", "  цитата " + "я" * 400, 0.9
    )
    assert ok.kind == "confirmed" and ok.url == "https://a.example/p"  # запрос и фрагмент отброшены
    assert ok.excerpt is not None and len(ok.excerpt) == 200


def test_inspect_site_reports_fetch_error_code(site: LocalSite) -> None:
    site.routes["/"] = Resp(status=404)
    rep = inspect_site(fetcher_for(site), f"http://site.test:{site.port}", "site.test", lambda: None,
                       last_attempt=False)  # fmt: skip
    assert rep.outcome == "unreachable" and rep.error_code == "http_error"
    assert isinstance(FetchError("x", "y"), Exception)
