"""Проверка сайта компании: загрузка страниц, факты с доказательствами, пересчёт оценки.

Сеть выполняется ВНЕ транзакции БД: сначала читаем компанию, затем скачиваем и разбираем страницы,
после этого одной короткой транзакцией заменяем факты источника `website`, пересчитываем оценку
(rules-v1) и пишем события. Персональные данные (адреса почты, телефоны) не сохраняются: фиксируется
только факт публикации контакта организации со ссылкой на страницу.
"""

from __future__ import annotations

import logging
import re
import uuid
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Literal
from urllib.parse import urlsplit

from sqlalchemy import delete, select
from sqlalchemy.orm import Session, sessionmaker

from app import security
from app.models import ActivityEvent, Company, CompanyFact, LeadScore
from app.services.html_facts import EXCERPT_MAX, Evidence, PageFindings, clean_text, extract_page
from app.services.jobs import PermanentError, RetryableError
from app.services.safe_fetch import FetchError, PageBudget, SafeFetcher
from app.services.scoring import (
    SCORE_RULE_VERSION,
    ScoreInput,
    import_score_input,
    score_company,
)

log = logging.getLogger("leadhunter.enrich")

FACT_SOURCE = "website"
MAX_INTERNAL_PAGES = 4
MAX_SERVICE_FACTS = 6
MIN_TEXT_FOR_WORKING_SITE = 40

# Ошибки, при которых проверка не даёт сведений о сайте: оценка не меняется.
SKIPPED_CODES = frozenset(
    {
        "robots_disallowed",
        "host_blocked",
        "invalid_url",
        "scheme_not_allowed",
        "port_not_allowed",
        "credentials_in_url",
        "page_budget_exceeded",
    }
)

Outcome = Literal["checked", "unreachable", "skipped"]

# Ключевые слова для выбора внутренних страниц: (приоритет, шаблон по URL и тексту ссылки).
_LINK_PRIORITY: tuple[tuple[int, re.Pattern[str]], ...] = (
    (40, re.compile(r"zapis|record|booking|appointment|запис|онлайн|online", re.I)),
    (30, re.compile(r"kontakt|contact|контакт|about|o-nas|о\s*нас", re.I)),
    (
        20,
        re.compile(r"uslug|service|price|prays|tseny|цен|прайс|услуг|стоимост|remont|ремонт", re.I),
    ),
)


@dataclass
class FactDraft:
    key: str
    kind: Literal["confirmed", "hypothesis"]
    text: str
    url: str | None
    excerpt: str | None
    confidence: float


@dataclass
class SiteReport:
    outcome: Outcome
    pages_checked: int = 0
    pages_failed: int = 0
    pages_blocked: int = 0
    error_code: str | None = None
    error_message: str | None = None
    home_url: str | None = None
    works: bool = False
    booking: bool | None = None
    demand_signals: int = 0
    has_contact: bool = False
    suspicious_instructions: bool = False
    facts: list[FactDraft] = field(default_factory=list)


@dataclass
class EnrichmentResult:
    outcome: Outcome
    pages_checked: int
    facts: int
    score_before: int
    score_after: int
    site_works: bool
    online_booking: str  # detected | not_detected | not_checked
    demand_signals: int
    has_business_contact: bool
    error_code: str | None = None

    def as_dict(self) -> dict[str, object]:
        return asdict(self)


def evidence_url(url: str) -> str:
    """URL без запроса и фрагмента (токены и идентификаторы в доказательства не попадают)."""
    p = urlsplit(url)
    return f"{p.scheme}://{p.netloc}{p.path or '/'}"[:2000]


def make_fact(
    key: str,
    kind: Literal["confirmed", "hypothesis"],
    text: str,
    url: str | None,
    excerpt: str | None,
    confidence: float,
) -> FactDraft:
    """Факт «подтверждён» только с URL и непустой выдержкой ≤200 символов, иначе — гипотеза."""
    clean = clean_text(excerpt)[:EXCERPT_MAX] if excerpt else None
    if kind == "confirmed" and (not url or not clean):
        kind, confidence = "hypothesis", min(confidence, 0.5)
    return FactDraft(
        key=key,
        kind=kind,
        text=text[:500],
        url=evidence_url(url) if url else None,
        excerpt=clean or None,
        confidence=confidence,
    )


# ---------------------------------------------------------------------------------------------
# Выбор страниц.


def _site_key(host: str) -> str:
    return host.lower().removeprefix("www.")


def pick_internal_pages(home_url: str, links: list[tuple[str, str]]) -> list[str]:
    """До 4 внутренних страниц того же сайта: фреймы, запись, контакты, услуги/цены."""
    home_parts = urlsplit(home_url)
    home_path = home_parts.path.rstrip("/") or "/"
    scored: dict[str, int] = {}
    for url, text in links:
        p = urlsplit(url)
        if _site_key(p.hostname or "") != _site_key(home_parts.hostname or ""):
            continue
        if (p.path.rstrip("/") or "/") == home_path and not p.query:
            continue
        score = 100 if text == "frame" else 0
        haystack = f"{p.path} {p.query} {text}"
        for weight, pattern in _LINK_PRIORITY:
            if pattern.search(haystack):
                score = max(score, weight)
        if score == 0:
            continue
        key = f"{p.scheme}://{p.netloc.lower()}{p.path.rstrip('/') or '/'}" + (
            f"?{p.query}" if p.query else ""
        )
        scored[key] = max(scored.get(key, 0), score)
    ordered = sorted(scored.items(), key=lambda kv: (-kv[1], len(kv[0]), kv[0]))
    return [u for u, _ in ordered[:MAX_INTERNAL_PAGES]]


# ---------------------------------------------------------------------------------------------
# Сбор признаков по сайту.


def _first(
    pairs: list[tuple[PageFindings, Evidence]], pick: Callable[[Evidence], bool] = lambda e: True
) -> tuple[PageFindings, Evidence] | None:
    for page, ev in pairs:
        if pick(ev):
            return page, ev
    return None


def inspect_site(
    fetcher: SafeFetcher,
    start_url: str,
    site_host: str,
    check: Callable[[], None],
    *,
    last_attempt: bool,
) -> SiteReport:
    """Загружает главную и до 4 внутренних страниц и превращает находки в факты."""
    budget = PageBudget()
    report = SiteReport(outcome="unreachable", home_url=start_url)
    check()
    try:
        home_res = fetcher.fetch_page(start_url, budget=budget)
    except FetchError as exc:
        return _failed_report(report, exc, last_attempt=last_attempt)
    home_final = home_res.url
    if _site_key(urlsplit(home_final).hostname or "") != _site_key(site_host):
        report.outcome = "skipped"
        report.error_code = "redirect_other_domain"
        report.error_message = "Сайт перенаправляет на другой домен — содержимое не использовалось."
        report.facts.append(
            make_fact("site", "hypothesis", report.error_message, start_url, None, 0.5)
        )
        return report
    report.home_url = home_final
    home = extract_page(home_res.body, home_final, home_res.charset)
    pages: list[PageFindings] = [home]
    report.pages_checked = 1

    for url in pick_internal_pages(home_final, home.links):
        check()
        try:
            res = fetcher.fetch_page(url, budget=budget)
        except FetchError as exc:
            if exc.code == "robots_disallowed":
                report.pages_blocked += 1
            else:
                report.pages_failed += 1
            continue
        if _site_key(urlsplit(res.url).hostname or "") != _site_key(site_host):
            report.pages_failed += 1
            continue
        pages.append(extract_page(res.body, res.url, res.charset))
        report.pages_checked += 1

    _aggregate(report, home, pages)
    return report


def _failed_report(report: SiteReport, exc: FetchError, *, last_attempt: bool) -> SiteReport:
    report.error_code = exc.code
    report.error_message = exc.message
    if exc.code in SKIPPED_CODES:
        report.outcome = "skipped"
        text = (
            "Проверка сайта пропущена: robots.txt запрещает автоматическую загрузку."
            if exc.code == "robots_disallowed"
            else f"Проверка сайта пропущена: {exc.message}"
        )
        report.facts.append(make_fact("site", "hypothesis", text, report.home_url, None, 0.6))
        return report
    if exc.retryable and not last_attempt:
        raise RetryableError(f"{exc.code}: {exc.message}")
    report.outcome = "unreachable"
    report.facts.append(
        make_fact(
            "site", "hypothesis", f"Сайт недоступен: {exc.message}", report.home_url, None, 0.7
        )
    )
    return report


def _aggregate(report: SiteReport, home: PageFindings, pages: list[PageFindings]) -> None:
    home_url = report.home_url or home.url
    content_pages = [p for p in pages if p.text_len >= MIN_TEXT_FOR_WORKING_SITE]
    works = not home.parse_failed and (
        home.text_len >= MIN_TEXT_FOR_WORKING_SITE or home.has_frames
    )
    report.outcome = "checked"
    report.works = works
    report.suspicious_instructions = any(p.suspicious_instructions for p in pages)

    def collect(attr: str) -> list[tuple[PageFindings, Evidence]]:
        return [(p, ev) for p in pages for ev in getattr(p, attr)]

    # Сайт
    if works and home.text_len >= MIN_TEXT_FOR_WORKING_SITE:
        excerpt = home.title or home.text_preview
        report.facts.append(
            make_fact(
                "site", "confirmed", "Сайт доступен и содержит текст", home_url, excerpt, 0.95
            )
        )
    elif works:
        report.facts.append(
            make_fact(
                "site",
                "hypothesis",
                "Сайт открывается, но содержимое загружается во фрейме — не проверено",
                home_url,
                home.title or None,
                0.5,
            )
        )
    else:
        report.facts.append(
            make_fact(
                "site",
                "hypothesis",
                "Сайт открывается, но почти не содержит текста",
                home_url,
                None,
                0.6,
            )  # fmt: skip
        )

    # Услуги, цены, режим работы — признаки спроса
    services: dict[str, tuple[PageFindings, Evidence]] = {}
    for page, ev in collect("services"):
        services.setdefault(ev.label, (page, ev))
    for label, (page, ev) in list(services.items())[:MAX_SERVICE_FACTS]:
        report.facts.append(
            make_fact(
                f"service:{label}",
                "confirmed",
                f"Услуга на сайте: {label}",
                page.url,
                ev.excerpt,
                0.8,
            )  # fmt: skip
        )
    price = _first(collect("prices"))
    if price:
        report.facts.append(
            make_fact(
                "prices", "confirmed", "На сайте указаны цены", price[0].url, price[1].excerpt, 0.85
            )  # fmt: skip
        )
    hours = _first(collect("hours"))
    if hours:
        report.facts.append(
            make_fact(
                "hours", "confirmed", "Указан режим работы", hours[0].url, hours[1].excerpt, 0.8
            )  # fmt: skip
        )
    report.demand_signals = (1 if services else 0) + (1 if price else 0) + (1 if hours else 0)

    # Онлайн-запись
    bookings = collect("booking")
    chosen = _first(bookings, lambda e: not e.weak) or _first(bookings)
    if chosen:
        page, ev = chosen
        report.booking = True
        text = {
            "widget": f"Обнаружена онлайн-запись: {ev.excerpt}",
            "phrase": "Обнаружена онлайн-запись (упоминание на странице)",
            "form": "Обнаружена форма записи",
            "button": "Обнаружена кнопка записи",
        }.get(ev.label, "Обнаружена онлайн-запись")
        report.facts.append(
            make_fact(
                "online_booking", "confirmed", text, page.url, ev.excerpt, 0.6 if ev.weak else 0.9
            )  # fmt: skip
        )
    elif works and content_pages:
        report.booking = False
        report.facts.append(
            make_fact(
                "online_booking",
                "hypothesis",
                f"Онлайн-запись не обнаружена на проверенных страницах ({report.pages_checked}). "
                "Это не доказательство её отсутствия.",
                home_url,
                None,
                0.4,
            )
        )
    else:
        report.booking = None
        report.facts.append(
            make_fact(
                "online_booking",
                "hypothesis",
                "Онлайн-запись не проверялась: на страницах нет видимого текста.",
                home_url,
                None,
                0.3,
            )  # fmt: skip
        )

    # Публичный бизнес-контакт: только факт наличия, без значения
    contacts = collect("contacts")
    for kind, label in (("phone", "телефон"), ("email", "e-mail")):
        found = _first(contacts, lambda e, k=kind: e.label == k)  # type: ignore[misc]
        if found:
            report.has_contact = True
            report.facts.append(
                make_fact(
                    f"contact:{kind}",
                    "confirmed",
                    f"Опубликован {label} организации (значение не сохранено)",
                    found[0].url,
                    found[1].excerpt,
                    0.9,
                )  # fmt: skip
            )


# ---------------------------------------------------------------------------------------------
# Запись результата.


def _booking_label(value: bool | None) -> str:
    return "not_checked" if value is None else "detected" if value else "not_detected"


def apply_report(
    db: Session,
    company_id: uuid.UUID,
    report: SiteReport,
    actor_id: uuid.UUID | None,
    now: datetime | None = None,
) -> EnrichmentResult:
    """Заменяет факты источника `website`, пересчитывает оценку и пишет события. Без commit."""
    now = now or security.now()
    company = db.get(Company, company_id)
    if company is None:
        raise PermanentError("Компания удалена.")
    ls = db.scalar(select(LeadScore).where(LeadScore.company_id == company_id))
    before = company.score

    db.execute(
        delete(CompanyFact).where(
            CompanyFact.company_id == company_id, CompanyFact.source == FACT_SOURCE
        )
    )
    for f in report.facts:
        db.add(
            CompanyFact(
                company_id=company_id,
                kind=f.kind,
                text=f.text,
                evidence_url=f.url,
                evidence_excerpt=f.excerpt,
                observed_at=now,
                confidence=f.confidence,
                source=FACT_SOURCE,
                fact_key=f.key,
            )
        )

    inp = ScoreInput(**ls.inputs) if ls else import_score_input(company.category)
    if report.outcome != "skipped":
        inp.site_works = report.works
        inp.online_booking_detected = report.booking if report.works else None
        inp.demand_signals = report.demand_signals
        inp.has_business_contact = report.has_contact
    inp.is_duplicate = company.duplicate_candidate
    inp.has_refusal = company.stage == "lost"
    score, reasons = score_company(inp)
    reasons_json = [dict(r) for r in reasons]
    if ls is None:
        db.add(
            LeadScore(
                company_id=company_id,
                score=score,
                rule_version=SCORE_RULE_VERSION,
                reasons=reasons_json,
                inputs=asdict(inp),
                created_at=now,
            )
        )
    else:
        ls.score, ls.rule_version = score, SCORE_RULE_VERSION
        ls.reasons, ls.inputs = reasons_json, asdict(inp)
    company.score = score
    company.updated_at = now
    if report.outcome != "skipped" and company.state == "discovered":
        company.state = "scored"

    result = EnrichmentResult(
        outcome=report.outcome,
        pages_checked=report.pages_checked,
        facts=len(report.facts),
        score_before=before,
        score_after=score,
        site_works=report.works,
        online_booking=_booking_label(report.booking),
        demand_signals=report.demand_signals,
        has_business_contact=report.has_contact,
        error_code=report.error_code,
    )
    payload: dict[str, object] = {
        "outcome": report.outcome,
        "pages_checked": report.pages_checked,
        "pages_blocked": report.pages_blocked,
        "facts": len(report.facts),
        "site_works": report.works,
        "online_booking": result.online_booking,
        "demand_signals": report.demand_signals,
        "business_contact": report.has_contact,
        "suspicious_instructions": report.suspicious_instructions,
    }
    if report.error_code:
        payload["error_code"] = report.error_code
    db.add(
        ActivityEvent(
            company_id=company_id,
            event_type="company.site_checked",
            actor_id=actor_id,
            payload_redacted=payload,
            created_at=now,
        )
    )
    if before != score:
        db.add(
            ActivityEvent(
                company_id=company_id,
                event_type="company.score_recalculated",
                actor_id=actor_id,
                payload_redacted={"from": before, "to": score, "source": "website_check"},
                created_at=now,
            )
        )
    return result


def run_enrichment(
    session_factory: sessionmaker[Session],
    fetcher: SafeFetcher,
    company_id: uuid.UUID,
    check: Callable[[], None],
    *,
    actor_id: uuid.UUID | None = None,
    last_attempt: bool = False,
) -> EnrichmentResult:
    with session_factory() as db:
        company = db.get(Company, company_id)
        if company is None:
            raise PermanentError("Компания не найдена.")
        website, domain = company.website, company.canonical_domain
    if not website and not domain:
        raise PermanentError("У компании не указан сайт.")
    start_url = website or f"https://{domain}"
    site_host = domain or urlsplit(start_url).hostname or ""
    report = inspect_site(fetcher, start_url, site_host, check, last_attempt=last_attempt)
    check()
    with session_factory() as db:
        result = apply_report(db, company_id, report, actor_id)
        db.commit()
    log.info(
        "enriched company=%s outcome=%s pages=%s facts=%s",
        company_id,
        result.outcome,
        result.pages_checked,
        result.facts,
    )
    return result
