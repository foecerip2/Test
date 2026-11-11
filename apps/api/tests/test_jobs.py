"""Очередь задач: постановка, атомарный захват, зависшие задачи, повторы, отмена, идемпотентность."""

from __future__ import annotations

import contextlib
import os
import threading
import uuid
from collections.abc import Iterator
from datetime import timedelta
from pathlib import Path

import pytest
import sqlalchemy as sa
from sqlalchemy.orm import Session, sessionmaker

from app import security
from app.db import Base, make_session_factory
from app.models import Job
from app.security import AppError
from app.services import jobs
from tests.conftest import Clock

LOCK = 300


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Clock:
    c = Clock()
    monkeypatch.setattr(security, "now", c.now)
    return c


@pytest.fixture
def factory(tmp_path: Path) -> Iterator[sessionmaker[Session]]:
    pg = os.environ.get("TEST_POSTGRES_URL")
    if pg:  # те же тесты очереди на реальной PostgreSQL
        engine = sa.create_engine(pg, pool_size=12, max_overflow=4)
        Base.metadata.drop_all(engine)
        Base.metadata.create_all(engine)
    else:
        engine = sa.create_engine(
            f"sqlite+pysqlite:///{tmp_path}/queue.db",
            connect_args={"check_same_thread": False, "timeout": 30},
        )
        Base.metadata.create_all(engine)
    yield make_session_factory(engine)
    engine.dispose()


@pytest.fixture
def db(factory: sessionmaker[Session]) -> Iterator[Session]:
    with factory() as s:
        yield s


def add(db: Session, payload: dict[str, object] | None = None, **kw: object) -> Job:
    job = jobs.enqueue(db, "enrich_company", payload or {"company_id": str(uuid.uuid4())}, **kw)  # type: ignore[arg-type]
    db.commit()
    return job


def reload(db: Session, job_id: uuid.UUID) -> Job:
    db.expire_all()
    return jobs.get_job(db, job_id)


# --- постановка и идемпотентность --------------------------------------------------------------------


def test_enqueue_defaults(db: Session, clock: Clock) -> None:
    j = add(db, {"company_id": "x"})
    j = reload(db, j.id)
    assert (j.state, j.attempts, j.max_attempts) == ("queued", 0, 3)
    assert j.run_after == clock.now() and j.locked_by is None and j.cancel_requested is False
    assert j.payload == {"company_id": "x"} and j.result is None and j.last_error is None


def test_dedupe_key_blocks_second_active_job(db: Session) -> None:
    first = add(db, dedupe_key="enrich_company:1")
    with pytest.raises(jobs.DuplicateJobError) as e:
        jobs.enqueue(db, "enrich_company", {}, dedupe_key="enrich_company:1")
    assert e.value.existing_id == first.id
    assert db.scalar(sa.select(sa.func.count()).select_from(Job)) == 1


def test_dedupe_key_released_after_terminal_states(db: Session, clock: Clock) -> None:
    for finish in ("succeeded", "failed", "cancelled"):
        j = add(db, dedupe_key="k")
        got = jobs.claim(db, "w", lock_timeout=LOCK)
        assert got is not None and got.id == j.id
        if finish == "succeeded":
            jobs.complete(db, j.id, "w", {})
        elif finish == "failed":
            jobs.fail(db, j.id, "w", "x", retryable=False)
        else:
            jobs.mark_cancelled(db, j.id, "w")
        assert reload(db, j.id).state == finish
    assert db.scalar(sa.select(sa.func.count()).select_from(Job)) == 3


def test_dedupe_applies_to_running_jobs_too(db: Session) -> None:
    j = add(db, dedupe_key="k")
    jobs.claim(db, "w", lock_timeout=LOCK)
    assert reload(db, j.id).state == "running"
    with pytest.raises(jobs.DuplicateJobError):
        jobs.enqueue(db, "enrich_company", {}, dedupe_key="k")


def test_concurrent_enqueue_with_same_key_creates_one_job(
    factory: sessionmaker[Session],
) -> None:
    barrier = threading.Barrier(8)
    outcomes: list[str] = []
    lock = threading.Lock()

    def worker() -> None:
        with factory() as s:
            barrier.wait()
            try:
                jobs.enqueue(s, "enrich_company", {}, dedupe_key="same", commit=True)
                res = "created"
            except jobs.DuplicateJobError:
                res = "duplicate"
            with lock:
                outcomes.append(res)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert outcomes.count("created") == 1 and outcomes.count("duplicate") == 7
    with factory() as s:
        assert s.scalar(sa.select(sa.func.count()).select_from(Job)) == 1


# --- захват ----------------------------------------------------------------------------------------------


def test_claim_empty_queue(db: Session) -> None:
    assert jobs.claim(db, "w", lock_timeout=LOCK) is None


def test_claim_marks_running_and_counts_attempt(db: Session, clock: Clock) -> None:
    j = add(db)
    got = jobs.claim(db, "worker-1", lock_timeout=LOCK)
    assert got is not None and got.id == j.id
    assert (got.state, got.attempts, got.locked_by) == ("running", 1, "worker-1")
    assert got.locked_at == clock.now()
    assert jobs.claim(db, "worker-2", lock_timeout=LOCK) is None  # уже занята


def test_claim_order_by_run_after_then_created(db: Session, clock: Clock) -> None:
    late = add(db, run_after=clock.now() - timedelta(minutes=1))
    early = add(db, run_after=clock.now() - timedelta(minutes=10))
    clock.advance(1)  # created_at различаются: при равных run_after порядок — по созданию
    first = add(db, run_after=reload(db, early.id).run_after)
    order = []
    while (j := jobs.claim(db, "w", lock_timeout=LOCK)) is not None:
        order.append(j.id)
    assert order == [early.id, first.id, late.id]


def test_job_is_not_claimable_before_run_after(db: Session, clock: Clock) -> None:
    j = add(db, run_after=clock.now() + timedelta(seconds=60))
    assert jobs.claim(db, "w", lock_timeout=LOCK) is None
    clock.advance(61)
    got = jobs.claim(db, "w", lock_timeout=LOCK)
    assert got is not None and got.id == j.id


def test_claim_filters_by_type(db: Session) -> None:
    other = jobs.enqueue(db, "other_type", {})
    db.commit()
    assert jobs.claim(db, "w", types=["enrich_company"], lock_timeout=LOCK) is None
    got = jobs.claim(db, "w", types=["other_type"], lock_timeout=LOCK)
    assert got is not None and got.id == other.id


def test_claim_is_atomic_one_job_many_threads(factory: sessionmaker[Session]) -> None:
    with factory() as s:
        add(s)
    barrier = threading.Barrier(16)
    winners: list[str] = []
    lock = threading.Lock()

    def worker(n: int) -> None:
        with factory() as s:
            barrier.wait()
            got = jobs.claim(s, f"w{n}", lock_timeout=LOCK)
            if got is not None:
                with lock:
                    winners.append(got.locked_by or "")

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(16)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(winners) == 1


def test_claim_is_atomic_many_jobs_many_threads_each_job_once(
    factory: sessionmaker[Session],
) -> None:
    with factory() as s:
        ids = {add(s).id for _ in range(60)}
    claimed: list[uuid.UUID] = []
    lock = threading.Lock()

    def worker(n: int) -> None:
        with factory() as s:
            while (got := jobs.claim(s, f"w{n}", lock_timeout=LOCK)) is not None:
                with lock:
                    claimed.append(got.id)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(claimed) == 60  # ни потерянных, ни продублированных
    assert set(claimed) == ids
    with factory() as s:
        rows = s.scalars(sa.select(Job)).all()
        assert all(r.state == "running" and r.attempts == 1 for r in rows)


# --- heartbeat и зависшие задачи ------------------------------------------------------------------------


def test_heartbeat_extends_lock_and_prevents_requeue(db: Session, clock: Clock) -> None:
    j = add(db)
    jobs.claim(db, "w1", lock_timeout=LOCK)
    clock.advance(LOCK - 10)
    assert jobs.heartbeat(db, j.id, "w1") == "ok"
    clock.advance(LOCK - 10)  # с момента захвата прошло больше LOCK, но heartbeat был недавно
    assert jobs.requeue_stale(db, lock_timeout=LOCK) == 0
    assert reload(db, j.id).state == "running"


def test_heartbeat_from_foreign_worker_is_lost(db: Session) -> None:
    j = add(db)
    jobs.claim(db, "w1", lock_timeout=LOCK)
    assert jobs.heartbeat(db, j.id, "w2") == "lost"
    assert reload(db, j.id).locked_by == "w1"


def test_heartbeat_reports_cancel_request(db: Session) -> None:
    j = add(db)
    jobs.claim(db, "w1", lock_timeout=LOCK)
    jobs.cancel(db, j.id)
    assert jobs.heartbeat(db, j.id, "w1") == "cancel"


def test_stale_running_job_is_returned_to_queue(db: Session, clock: Clock) -> None:
    j = add(db)
    jobs.claim(db, "dead-worker", lock_timeout=LOCK)
    clock.advance(LOCK + 1)
    got = jobs.claim(db, "w2", lock_timeout=LOCK)
    assert got is not None and got.id == j.id
    assert (got.locked_by, got.attempts) == ("w2", 2)
    assert "возвращена" in (got.last_error or "")


def test_stale_job_with_exhausted_attempts_fails(db: Session, clock: Clock) -> None:
    j = add(db, max_attempts=2)
    for n in range(2):
        got = jobs.claim(db, f"w{n}", lock_timeout=LOCK)
        assert got is not None
        clock.advance(LOCK + 1)
    assert jobs.claim(db, "w9", lock_timeout=LOCK) is None
    done = reload(db, j.id)
    assert done.state == "failed" and done.attempts == 2 and done.locked_by is None
    assert "исчерпаны" in (done.last_error or "")


def test_stale_job_with_cancel_request_is_cancelled(db: Session, clock: Clock) -> None:
    j = add(db)
    jobs.claim(db, "dead", lock_timeout=LOCK)
    jobs.cancel(db, j.id)
    clock.advance(LOCK + 1)
    assert jobs.claim(db, "w2", lock_timeout=LOCK) is None
    assert reload(db, j.id).state == "cancelled"


def test_fresh_running_job_is_not_requeued(db: Session, clock: Clock) -> None:
    j = add(db)
    jobs.claim(db, "w1", lock_timeout=LOCK)
    clock.advance(LOCK - 1)
    assert jobs.requeue_stale(db, lock_timeout=LOCK) == 0
    assert reload(db, j.id).state == "running"


def test_worker_restart_resumes_orphaned_job(db: Session, clock: Clock) -> None:
    """Воркер умер на задаче; после рестарта (новый id) задача через таймаут выполняется заново."""
    j = add(db)
    jobs.claim(db, "host:1#0", lock_timeout=LOCK)
    # «рестарт»: до таймаута задача считается занятой
    assert jobs.claim(db, "host:2#0", lock_timeout=LOCK) is None
    clock.advance(LOCK + 5)
    got = jobs.claim(db, "host:2#0", lock_timeout=LOCK)
    assert got is not None and got.id == j.id and got.attempts == 2
    assert jobs.complete(db, j.id, "host:2#0", {"ok": True}) is True
    assert reload(db, j.id).state == "succeeded"
    # «старый» воркер, очнувшись, не может ни завершить, ни испортить результат
    assert jobs.complete(db, j.id, "host:1#0", {"ok": False}) is False
    assert jobs.fail(db, j.id, "host:1#0", "late") is None
    assert reload(db, j.id).result == {"ok": True}


# --- завершение, повторы ---------------------------------------------------------------------------------


def test_complete_stores_result_and_clears_lock(db: Session) -> None:
    j = add(db)
    jobs.claim(db, "w", lock_timeout=LOCK)
    assert jobs.complete(db, j.id, "w", {"pages": 3}) is True
    done = reload(db, j.id)
    assert (done.state, done.result, done.locked_by, done.locked_at) == (
        "succeeded", {"pages": 3}, None, None,
    )  # fmt: skip


def test_complete_is_idempotent_second_call_is_noop(db: Session) -> None:
    j = add(db)
    jobs.claim(db, "w", lock_timeout=LOCK)
    assert jobs.complete(db, j.id, "w", {"n": 1}) is True
    assert jobs.complete(db, j.id, "w", {"n": 2}) is False
    assert reload(db, j.id).result == {"n": 1}


def test_complete_by_foreign_worker_is_rejected(db: Session) -> None:
    j = add(db)
    jobs.claim(db, "w1", lock_timeout=LOCK)
    assert jobs.complete(db, j.id, "w2", {}) is False
    assert reload(db, j.id).state == "running"


def test_fail_retries_with_exponential_backoff(db: Session, clock: Clock) -> None:
    j = add(db)
    expected = [30, 60]
    for attempt, delay in enumerate(expected, start=1):
        got = jobs.claim(db, "w", lock_timeout=LOCK)
        assert got is not None and got.attempts == attempt
        assert jobs.fail(db, j.id, "w", "timeout", jitter=1.0) == "queued"
        row = reload(db, j.id)
        assert row.run_after == clock.now() + timedelta(seconds=delay)
        assert jobs.claim(db, "w", lock_timeout=LOCK) is None  # ещё рано
        clock.advance(delay)
    got = jobs.claim(db, "w", lock_timeout=LOCK)
    assert got is not None and got.attempts == 3
    assert jobs.fail(db, j.id, "w", "timeout again", jitter=1.0) == "failed"  # максимум 3 попытки
    assert reload(db, j.id).last_error == "timeout again"
    clock.advance(100000)
    assert jobs.claim(db, "w", lock_timeout=LOCK) is None


def test_permanent_error_is_not_retried(db: Session) -> None:
    j = add(db)
    jobs.claim(db, "w", lock_timeout=LOCK)
    assert jobs.fail(db, j.id, "w", "нет сайта", retryable=False) == "failed"
    row = reload(db, j.id)
    assert row.attempts == 1 and row.state == "failed"


def test_backoff_has_jitter_and_cap() -> None:
    samples = [jobs.backoff_seconds(1) for _ in range(300)]
    assert all(22.5 <= s <= 37.5 for s in samples)
    assert len({round(s, 3) for s in samples}) > 50  # значения действительно разные
    assert jobs.backoff_seconds(2, jitter=1.0) == 60
    assert jobs.backoff_seconds(3, jitter=1.0) == 120
    assert jobs.backoff_seconds(30, jitter=1.0) == 3600  # потолок


def test_release_returns_job_without_spending_attempt(db: Session, clock: Clock) -> None:
    j = add(db)
    jobs.claim(db, "w", lock_timeout=LOCK)
    assert jobs.release(db, j.id, "w") is True
    row = reload(db, j.id)
    assert (row.state, row.attempts, row.locked_by) == ("queued", 0, None)
    again = jobs.claim(db, "w2", lock_timeout=LOCK)
    assert again is not None and again.attempts == 1


def test_release_by_foreign_worker_is_rejected(db: Session) -> None:
    j = add(db)
    jobs.claim(db, "w1", lock_timeout=LOCK)
    assert jobs.release(db, j.id, "w2") is False
    assert reload(db, j.id).state == "running"


# --- отмена ----------------------------------------------------------------------------------------------------


def test_cancel_queued_is_immediate_and_final(db: Session) -> None:
    j = add(db)
    out = jobs.cancel(db, j.id)
    assert out.state == "cancelled" and out.cancel_requested is True
    assert jobs.claim(db, "w", lock_timeout=LOCK) is None


def test_cancel_running_sets_flag_and_worker_finishes_cancelling(db: Session) -> None:
    j = add(db)
    jobs.claim(db, "w", lock_timeout=LOCK)
    out = jobs.cancel(db, j.id)
    assert out.state == "running" and out.cancel_requested is True
    assert jobs.cancel(db, j.id).cancel_requested is True  # повтор — идемпотентно
    assert jobs.heartbeat(db, j.id, "w") == "cancel"
    assert jobs.mark_cancelled(db, j.id, "w") is True
    assert reload(db, j.id).state == "cancelled"


def test_failure_after_cancel_request_ends_cancelled_not_retried(db: Session) -> None:
    j = add(db)
    jobs.claim(db, "w", lock_timeout=LOCK)
    jobs.cancel(db, j.id)
    assert jobs.fail(db, j.id, "w", "boom") == "cancelled"


@pytest.mark.parametrize("final", ["succeeded", "failed", "cancelled"])
def test_cancel_finished_job_is_conflict(db: Session, final: str) -> None:
    j = add(db)
    jobs.claim(db, "w", lock_timeout=LOCK)
    if final == "succeeded":
        jobs.complete(db, j.id, "w", {})
    elif final == "failed":
        jobs.fail(db, j.id, "w", "x", retryable=False)
    else:
        jobs.mark_cancelled(db, j.id, "w")
    with pytest.raises(jobs.JobStateError) as e:
        jobs.cancel(db, j.id)
    assert e.value.state == final


def test_cancel_unknown_job(db: Session) -> None:
    with pytest.raises(AppError) as e:
        jobs.cancel(db, uuid.uuid4())
    assert e.value.status_code == 404


def test_cancel_racing_with_claim_never_loses_the_request(factory: sessionmaker[Session]) -> None:
    """Отмена и захват одновременно: итог — либо cancelled, либо running+cancel_requested."""
    for _ in range(10):
        with factory() as s:
            j = add(s)
            jid = j.id
        barrier = threading.Barrier(2)

        def do_cancel(jid: uuid.UUID = jid, barrier: threading.Barrier = barrier) -> None:
            with factory() as s:
                barrier.wait()
                with contextlib.suppress(jobs.JobStateError):
                    jobs.cancel(s, jid)

        def do_claim(barrier: threading.Barrier = barrier) -> None:
            with factory() as s:
                barrier.wait()
                jobs.claim(s, "w", lock_timeout=LOCK)

        ts = [threading.Thread(target=do_cancel), threading.Thread(target=do_claim)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        with factory() as s:
            row = jobs.get_job(s, jid)
            assert (row.state == "cancelled") or (row.state == "running" and row.cancel_requested)
            s.execute(sa.delete(Job))
            s.commit()


# --- ошибки без секретов и ПД --------------------------------------------------------------------------------------


def test_sanitize_error_removes_pd_and_secrets() -> None:
    raw = (
        "Failed for ivan.petrov@example.com phone +7 (900) 123-45-67 at "
        "https://shop.example.com/path/secret?token=abc&x=1 with password=hunter2 and key: sk-1234"
    )
    clean = jobs.sanitize_error(raw)
    for leaked in ("ivan.petrov", "123-45-67", "secret", "token=abc", "hunter2", "sk-1234"):
        assert leaked not in clean, clean
    assert "shop.example.com" in clean


def test_sanitize_error_truncates_and_collapses_whitespace() -> None:
    clean = jobs.sanitize_error("a\n\n  b " + "x" * 1000)
    assert len(clean) == 500 and clean.startswith("a b ")


def test_fail_stores_sanitized_error(db: Session) -> None:
    j = add(db)
    jobs.claim(db, "w", lock_timeout=LOCK)
    jobs.fail(db, j.id, "w", "boom for a@b.example password=xyz", retryable=False)
    err = reload(db, j.id).last_error or ""
    assert "a@b.example" not in err and "xyz" not in err


# --- список (API) -----------------------------------------------------------------------------------------------------


def test_list_jobs_filters_and_pages(db: Session, clock: Clock) -> None:
    ids = []
    for _ in range(5):
        clock.advance(1)
        ids.append(add(db).id)
    clock.advance(1)
    other = jobs.enqueue(db, "other", {})
    db.commit()
    first = jobs.list_jobs(db, limit=4)
    assert [j.id for j in first.items][0] == other.id  # новые — первыми
    assert first.has_more and first.next_cursor
    second = jobs.list_jobs(db, limit=4, cursor=first.next_cursor)
    assert len(second.items) == 2 and not second.has_more and second.next_cursor is None
    seen = [j.id for j in first.items + second.items]
    assert len(seen) == len(set(seen)) == 6
    assert [j.id for j in jobs.list_jobs(db, job_type="other").items] == [other.id]
    assert len(jobs.list_jobs(db, state="queued").items) == 6
    assert jobs.list_jobs(db, state="running").items == []


def test_list_jobs_pagination_with_equal_timestamps_is_stable(db: Session) -> None:
    for _ in range(7):
        add(db)  # одинаковый created_at (часы не двигаются вне фикстуры clock)
    seen: list[uuid.UUID] = []
    cursor = None
    while True:
        page = jobs.list_jobs(db, limit=3, cursor=cursor)
        seen += [j.id for j in page.items]
        cursor = page.next_cursor
        if not page.has_more:
            break
    assert len(seen) == len(set(seen)) == 7


def test_list_jobs_rejects_bad_cursor(db: Session) -> None:
    with pytest.raises(AppError) as e:
        jobs.list_jobs(db, cursor="!!!not-a-cursor")
    assert e.value.status_code == 422 and e.value.code == "INVALID_CURSOR"
