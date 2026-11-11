"""Реестр обработчиков задач по типу. Обработчик получает контекст и возвращает JSON-результат."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from sqlalchemy.orm import Session, sessionmaker

from app.config import Settings
from app.services.enrichment import run_enrichment
from app.services.jobs import PermanentError
from app.services.safe_fetch import SafeFetcher

ENRICH_COMPANY = "enrich_company"


@dataclass
class JobContext:
    job_id: uuid.UUID
    job_type: str
    payload: dict[str, Any]
    attempts: int
    max_attempts: int
    created_by: uuid.UUID | None
    settings: Settings
    session_factory: sessionmaker[Session]
    fetcher: SafeFetcher
    #: Между шагами: продлевает блокировку; бросает JobCancelled / JobInterrupted.
    check: Callable[[], None]


Handler = Callable[[JobContext], dict[str, Any] | None]


def handle_enrich_company(ctx: JobContext) -> dict[str, Any] | None:
    raw = ctx.payload.get("company_id")
    try:
        company_id = uuid.UUID(str(raw))
    except ValueError:
        raise PermanentError("В задаче нет корректного company_id.") from None
    result = run_enrichment(
        ctx.session_factory,
        ctx.fetcher,
        company_id,
        ctx.check,
        actor_id=ctx.created_by,
        last_attempt=ctx.attempts >= ctx.max_attempts,
    )
    return result.as_dict()


HANDLERS: dict[str, Handler] = {ENRICH_COMPANY: handle_enrich_company}
