"""Общие помощники для тестов компаний: вход, создание записей, CSV."""

from __future__ import annotations

import uuid
from dataclasses import asdict
from datetime import datetime
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app import security
from app.models import Company, CompanyFact, LeadScore, User
from app.services.companies import make_search_text
from app.services.normalize import normalize_city, normalize_name
from app.services.scoring import SCORE_RULE_VERSION, import_score_input, score_company
from tests.conftest import OWNER, Ctx

CSV_HEADER = "название;город;сайт;инн;категория"
USER = "alice@example.com"


def csv_text(*rows: str, header: str = CSV_HEADER) -> str:
    return "\r\n".join([header, *rows]) + "\r\n"


def login_owner(ctx: Ctx) -> TestClient:
    ctx.login(OWNER)
    return ctx.client


def login_pending(ctx: Ctx, email: str = USER) -> TestClient:
    c = ctx.new_client()
    ctx.login(email, client=c)
    return c


def login_active_user(ctx: Ctx, owner: TestClient, email: str = USER) -> TestClient:
    c = login_pending(ctx, email)
    uid = ctx.user(email).id
    r = owner.post(f"/api/v1/admin/users/{uid}/approve", headers=ctx.csrf(owner))
    assert r.status_code == 200, r.text
    return c


def add_company(
    ctx: Ctx,
    name: str = "Север Авто",
    city: str = "Казань",
    *,
    category: str = "Автосервис",
    inn: str | None = None,
    domain: str | None = None,
    score: int | None = None,
    stage: str = "new",
    state: str = "discovered",
    created_at: datetime | None = None,
    updated_at: datetime | None = None,
    demo: bool = False,
    note: str = "",
) -> uuid.UUID:
    now = security.now()
    cid = uuid.uuid4()
    inp = import_score_input(category)
    auto_score, reasons = score_company(inp)
    with ctx.db() as db:
        c = Company(
            id=cid,
            name=name,
            normalized_name=normalize_name(name),
            inn=inn,
            city=city,
            city_norm=normalize_city(city),
            category=category,
            website=f"https://{domain}" if domain else None,
            canonical_domain=domain,
            state=state,
            stage=stage,
            note=note,
            source_label="Тест",
            demo=demo,
            score=auto_score if score is None else score,
            search_text=make_search_text(name, city, category, domain),
            created_at=created_at or now,
            updated_at=updated_at or created_at or now,
        )
        db.add(c)
        db.flush()
        db.add(
            LeadScore(
                company_id=cid,
                score=c.score,
                rule_version=SCORE_RULE_VERSION,
                reasons=[dict(r) for r in reasons],
                inputs=asdict(inp),
                created_at=now,
            )
        )
        db.commit()
    return cid


def add_fact(
    ctx: Ctx,
    company_id: uuid.UUID,
    *,
    kind: str = "confirmed",
    text: str = "Есть запись по телефону",
    url: str | None = "https://example.com/p",
    excerpt: str | None = "Запись по телефону",
    observed_at: datetime | None = None,
    confidence: float = 0.9,
) -> uuid.UUID:
    fid = uuid.uuid4()
    with ctx.db() as db:
        db.add(
            CompanyFact(
                id=fid,
                company_id=company_id,
                kind=kind,
                text=text,
                evidence_url=url,
                evidence_excerpt=excerpt,
                observed_at=observed_at or security.now(),
                confidence=confidence,
            )
        )
        db.commit()
    return fid


def post_import(
    ctx: Ctx,
    client: TestClient,
    text: str | bytes,
    *,
    dry_run: bool | None = True,
    content_type: str = "text/csv; charset=utf-8",
    csrf: bool = True,
) -> Any:
    params = {} if dry_run is None else {"dry_run": "true" if dry_run else "false"}
    headers = {"Content-Type": content_type}
    if csrf:
        headers.update(ctx.csrf(client))
    data = text.encode("utf-8") if isinstance(text, str) else text
    return client.post("/api/v1/imports/companies", params=params, content=data, headers=headers)


def count(ctx: Ctx, model: Any) -> int:
    with ctx.db() as db:
        return db.scalar(select(func.count()).select_from(model)) or 0


def set_user_status(ctx: Ctx, email: str, status: str) -> None:
    with ctx.db() as db:
        u = db.scalar(select(User).where(User.email == email))
        assert u is not None
        u.status = status
        db.commit()
