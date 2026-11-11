"""Очередь задач в PostgreSQL (ADR-017): постановка, захват, heartbeat, повторы, отмена.

Работает и на PostgreSQL (`SELECT … FOR UPDATE SKIP LOCKED`), и на SQLite (тесты). На обоих
захват завершается условным `UPDATE … WHERE state = 'queued'` (compare-and-set), поэтому две
конкурентные транзакции никогда не получат одну и ту же задачу.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Literal

from sqlalchemy import and_, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import security
from app.models import ACTIVE_JOB_STATES, Job
from app.security import AppError

DEFAULT_MAX_ATTEMPTS = 3
BACKOFF_BASE_SECONDS = 30
BACKOFF_CAP_SECONDS = 3600
ERROR_MAX_LEN = 500


class JobError(Exception):
    """Базовое исключение обработчика задач."""


class RetryableError(JobError):
    """Временная ошибка: задачу можно повторить (если остались попытки)."""


class PermanentError(JobError):
    """Постоянная ошибка: повтор бессмыслен (сайт отсутствует, запрет robots и т. п.)."""


class JobCancelled(JobError):  # noqa: N818
    """Пользователь запросил отмену выполняющейся задачи."""


class JobInterrupted(JobError):  # noqa: N818
    """Воркер останавливается: задача возвращается в очередь без потери попытки."""


class DuplicateJobError(Exception):
    def __init__(self, existing_id: uuid.UUID) -> None:
        super().__init__(str(existing_id))
        self.existing_id = existing_id


class JobStateError(Exception):
    """Операция невозможна в текущем состоянии задачи."""

    def __init__(self, state: str) -> None:
        super().__init__(state)
        self.state = state


_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_URL = re.compile(r"(https?://[^\s/?#]+)[^\s]*", re.IGNORECASE)
_DIGITS = re.compile(r"\+?\d[\d\s().-]{6,}\d")
_SECRET = re.compile(r"(?i)(password|passwd|token|secret|key|authorization)\s*[=:]\s*\S+")


def sanitize_error(message: str) -> str:
    """Убирает из текста ошибки адреса, номера, пути URL и «ключ=значение»: без секретов и ПД."""
    s = _SECRET.sub(r"\1=***", message)
    s = _EMAIL.sub("***@***", s)
    s = _URL.sub(r"\1/…", s)
    s = _DIGITS.sub("***", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:ERROR_MAX_LEN]


def backoff_seconds(attempts: int, jitter: float | None = None) -> float:
    """Экспоненциальная задержка 30 с · 2^(n-1) с джиттером ±25 % (потолок — час)."""
    base = min(BACKOFF_CAP_SECONDS, BACKOFF_BASE_SECONDS * 2 ** max(0, attempts - 1))
    if jitter is None:
        jitter = secrets.SystemRandom().uniform(0.75, 1.25)
    return float(base * jitter)


def dedupe_key_for(job_type: str, entity_id: uuid.UUID | str) -> str:
    return f"{job_type}:{entity_id}"


def _active_by_key(db: Session, key: str) -> Job | None:
    return db.scalar(
        select(Job).where(Job.dedupe_key == key, Job.state.in_(ACTIVE_JOB_STATES)).limit(1)
    )


def _fresh(db: Session, job_id: uuid.UUID) -> Job:
    return db.execute(
        select(Job).where(Job.id == job_id).execution_options(populate_existing=True)
    ).scalar_one()


def _rows(res: Any) -> int:
    return int(getattr(res, "rowcount", 0) or 0)


def enqueue(
    db: Session,
    job_type: str,
    payload: dict[str, Any],
    *,
    created_by: uuid.UUID | None = None,
    dedupe_key: str | None = None,
    campaign_id: uuid.UUID | None = None,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
    run_after: datetime | None = None,
    commit: bool = False,
) -> Job:
    """Ставит задачу. Если с тем же `dedupe_key` уже есть активная — `DuplicateJobError`."""
    if dedupe_key is not None:
        existing = _active_by_key(db, dedupe_key)
        if existing is not None:
            raise DuplicateJobError(existing.id)
    now = security.now()
    job = Job(
        type=job_type,
        payload=payload,
        state="queued",
        attempts=0,
        max_attempts=max_attempts,
        run_after=run_after or now,
        dedupe_key=dedupe_key,
        campaign_id=campaign_id,
        created_by=created_by,
        created_at=now,
        updated_at=now,
    )
    db.add(job)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        if dedupe_key is not None:
            existing = _active_by_key(db, dedupe_key)
            if existing is not None:
                raise DuplicateJobError(existing.id) from None
        raise
    if commit:
        db.commit()
    return job


def get_job(db: Session, job_id: uuid.UUID) -> Job:
    job = db.get(Job, job_id)
    if job is None:
        raise AppError(404, "NOT_FOUND", "Задача не найдена.")
    return job


# ---------------------------------------------------------------------------------------------
# Захват и учёт зависших задач (вызывается воркером).


def requeue_stale(db: Session, *, lock_timeout: int, now: datetime | None = None) -> int:
    """`running` с устаревшим `locked_at` возвращаются в очередь (или падают, если попыток нет)."""
    now = now or security.now()
    cutoff = now - timedelta(seconds=lock_timeout)
    stale = and_(Job.state == "running", Job.locked_at < cutoff)
    total = 0
    # 1) отмена, запрошенная до потери воркера
    total += _rows(
        db.execute(
            update(Job)
            .where(stale, Job.cancel_requested.is_(True))
            .values(state="cancelled", locked_by=None, locked_at=None, updated_at=now)
        )
    )
    # 2) попытки исчерпаны — задача падает (не зацикливаемся на «убивающей» задаче)
    total += _rows(
        db.execute(
            update(Job)
            .where(stale, Job.attempts >= Job.max_attempts)
            .values(
                state="failed",
                locked_by=None,
                locked_at=None,
                last_error="Воркер перестал отвечать; попытки исчерпаны.",
                updated_at=now,
            )
        )
    )
    # 3) иначе — обратно в очередь немедленно
    total += _rows(
        db.execute(
            update(Job)
            .where(stale)
            .values(
                state="queued",
                locked_by=None,
                locked_at=None,
                run_after=now,
                last_error="Воркер перестал отвечать; задача возвращена в очередь.",
                updated_at=now,
            )
        )
    )
    db.commit()
    return total


def claim(
    db: Session,
    worker_id: str,
    *,
    types: list[str] | None = None,
    lock_timeout: int = 300,
    now: datetime | None = None,
) -> Job | None:
    """Атомарно берёт самую раннюю готовую задачу. Возвращает None, если очередь пуста."""
    now = now or security.now()
    requeue_stale(db, lock_timeout=lock_timeout, now=now)
    is_pg = db.get_bind().dialect.name == "postgresql"
    for _ in range(8):
        stmt = select(Job.id).where(Job.state == "queued", Job.run_after <= now)
        if types:
            stmt = stmt.where(Job.type.in_(types))
        stmt = stmt.order_by(Job.run_after, Job.created_at, Job.id).limit(1)
        if is_pg:
            stmt = stmt.with_for_update(skip_locked=True)
        job_id = db.scalar(stmt)
        if job_id is None:
            db.rollback()
            return None
        res = db.execute(
            update(Job)
            .where(Job.id == job_id, Job.state == "queued")
            .values(
                state="running",
                attempts=Job.attempts + 1,
                locked_by=worker_id,
                locked_at=now,
                updated_at=now,
            )
        )
        if _rows(res) == 1:
            db.commit()
            return _fresh(db, job_id)
        db.rollback()  # проиграли гонку — пробуем следующую
    return None


HeartbeatState = Literal["ok", "cancel", "lost"]


def heartbeat(
    db: Session, job_id: uuid.UUID, worker_id: str, now: datetime | None = None
) -> HeartbeatState:
    """Продлевает блокировку. `cancel` — запрошена отмена; `lost` — задача уже не наша."""
    now = now or security.now()
    res = db.execute(
        update(Job)
        .where(Job.id == job_id, Job.state == "running", Job.locked_by == worker_id)
        .values(locked_at=now, updated_at=now)
    )
    if _rows(res) != 1:
        db.commit()
        return "lost"
    cancel = db.scalar(select(Job.cancel_requested).where(Job.id == job_id))
    db.commit()
    return "cancel" if cancel else "ok"


def _finish(
    db: Session, job_id: uuid.UUID, worker_id: str, values: dict[str, Any], now: datetime
) -> bool:
    res = db.execute(
        update(Job)
        .where(Job.id == job_id, Job.state == "running", Job.locked_by == worker_id)
        .values(locked_by=None, locked_at=None, updated_at=now, **values)
    )
    db.commit()
    return _rows(res) == 1


def complete(
    db: Session,
    job_id: uuid.UUID,
    worker_id: str,
    result: dict[str, Any] | None = None,
    now: datetime | None = None,
) -> bool:
    values: dict[str, Any] = {"state": "succeeded", "result": result, "last_error": None}
    return _finish(db, job_id, worker_id, values, now or security.now())


def mark_cancelled(
    db: Session, job_id: uuid.UUID, worker_id: str, now: datetime | None = None
) -> bool:
    return _finish(db, job_id, worker_id, {"state": "cancelled"}, now or security.now())


def release(db: Session, job_id: uuid.UUID, worker_id: str, now: datetime | None = None) -> bool:
    """Мягкая остановка воркера: задача возвращается в очередь, попытка не тратится."""
    now = now or security.now()
    job = db.scalar(
        select(Job)
        .where(Job.id == job_id, Job.state == "running", Job.locked_by == worker_id)
        .execution_options(populate_existing=True)
    )
    if job is None:
        db.rollback()
        return False
    values: dict[str, Any] = {
        "state": "queued",
        "run_after": now,
        "attempts": max(0, job.attempts - 1),
    }
    return _finish(db, job_id, worker_id, values, now)


def fail(
    db: Session,
    job_id: uuid.UUID,
    worker_id: str,
    error: str,
    *,
    retryable: bool = True,
    now: datetime | None = None,
    jitter: float | None = None,
) -> str | None:
    """Фиксирует ошибку: повтор с экспоненциальной задержкой или финальный `failed`.

    Возвращает новое состояние или None, если задача уже не принадлежит воркеру.
    """
    now = now or security.now()
    job = db.scalar(
        select(Job)
        .where(Job.id == job_id, Job.state == "running", Job.locked_by == worker_id)
        .execution_options(populate_existing=True)
    )
    if job is None:
        db.rollback()
        return None
    message = sanitize_error(error)
    values: dict[str, Any]
    if job.cancel_requested:
        state, values = "cancelled", {"last_error": message}
    elif retryable and job.attempts < job.max_attempts:
        delay = backoff_seconds(job.attempts, jitter)
        state = "queued"
        values = {"run_after": now + timedelta(seconds=delay), "last_error": message}
    else:
        state, values = "failed", {"last_error": message}
    ok = _finish(db, job_id, worker_id, {"state": state, **values}, now)
    return state if ok else None


# ---------------------------------------------------------------------------------------------
# Отмена и список (API).


def cancel(db: Session, job_id: uuid.UUID, now: datetime | None = None) -> Job:
    """queued → cancelled сразу; running → флаг отмены, который проверяет воркер."""
    now = now or security.now()
    job = get_job(db, job_id)
    if job.state == "queued":
        res = db.execute(
            update(Job)
            .where(Job.id == job_id, Job.state == "queued")
            .values(state="cancelled", cancel_requested=True, updated_at=now)
        )
        if _rows(res) == 1:
            db.commit()
            return _fresh(db, job_id)
        db.rollback()  # задачу успел захватить воркер
        job = _fresh(db, job_id)
    if job.state == "running":
        db.execute(
            update(Job)
            .where(Job.id == job_id, Job.state == "running")
            .values(cancel_requested=True, updated_at=now)
        )
        db.commit()
        fresh = _fresh(db, job_id)
        if fresh.state == "running":
            return fresh
        raise JobStateError(fresh.state)
    raise JobStateError(job.state)


@dataclass
class JobPage:
    items: list[Job]
    has_more: bool
    next_cursor: str | None


def _encode_cursor(job: Job) -> str:
    raw = json.dumps({"t": job.created_at.isoformat(), "id": str(job.id)})
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def _decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
        data = json.loads(raw)
        return datetime.fromisoformat(data["t"]), uuid.UUID(data["id"])
    except (ValueError, KeyError, TypeError, binascii.Error):
        raise AppError(422, "INVALID_CURSOR", "Недействительный курсор.") from None


def list_jobs(
    db: Session,
    *,
    state: str | None = None,
    job_type: str | None = None,
    limit: int = 50,
    cursor: str | None = None,
) -> JobPage:
    stmt = select(Job)
    if state:
        stmt = stmt.where(Job.state == state)
    if job_type:
        stmt = stmt.where(Job.type == job_type)
    if cursor:
        t, cid = _decode_cursor(cursor)
        stmt = stmt.where(or_(Job.created_at < t, and_(Job.created_at == t, Job.id < cid)))
    rows = list(
        db.scalars(stmt.order_by(Job.created_at.desc(), Job.id.desc()).limit(limit + 1)).all()
    )
    has_more = len(rows) > limit
    items = rows[:limit]
    return JobPage(
        items=items,
        has_more=has_more,
        next_cursor=_encode_cursor(items[-1]) if has_more and items else None,
    )
