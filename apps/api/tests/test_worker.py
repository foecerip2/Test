"""Воркер: выполнение задач, ошибки, отмена, мягкая остановка, рестарт, heartbeat."""

from __future__ import annotations

import inspect
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import select

from app import worker as worker_module
from app.config import Settings
from app.db import make_engine, make_session_factory
from app.models import CompanyFact, Job
from app.services import jobs
from app.services.job_handlers import ENRICH_COMPANY, HANDLERS, JobContext
from app.services.jobs import PermanentError, RetryableError
from app.worker import Worker, heartbeat_ok, main
from tests.conftest import Ctx
from tests.helpers import add_company
from tests.netutil import LocalSite, Resp
from tests.test_enrichment import fetcher_for, make_company, page, rich_site


def make_worker(ctx: Ctx, handlers: dict[str, Any] | None = None, **kw: Any) -> Worker:
    return Worker(
        ctx.settings, ctx.app.state.session_factory, handlers=handlers, worker_id="test", **kw
    )


def enqueue(
    ctx: Ctx, payload: dict[str, Any] | None = None, job_type: str = "t", **kw: Any
) -> uuid.UUID:
    with ctx.db() as db:
        return jobs.enqueue(db, job_type, payload or {}, commit=True, **kw).id


def job(ctx: Ctx, job_id: uuid.UUID) -> Job:
    with ctx.db() as db:
        j = db.get(Job, job_id)
        assert j is not None
        return j


def test_registry_contains_enrich_company() -> None:
    assert ENRICH_COMPANY in HANDLERS


def test_worker_does_not_run_migrations() -> None:
    src = inspect.getsource(worker_module)
    assert "alembic" not in src and "create_all" not in src


def test_empty_queue(ctx: Ctx) -> None:
    assert make_worker(ctx, {"t": lambda c: None}).process_one() is False


def test_success_stores_result(ctx: Ctx) -> None:
    jid = enqueue(ctx, {"x": 1})
    w = make_worker(ctx, {"t": lambda c: {"echo": c.payload["x"], "attempt": c.attempts}})
    assert w.process_one() is True
    j = job(ctx, jid)
    assert j.state == "succeeded" and j.result == {"echo": 1, "attempt": 1} and j.locked_by is None


def test_only_registered_types_are_claimed(ctx: Ctx) -> None:
    other = enqueue(ctx, job_type="unknown")
    assert make_worker(ctx, {"t": lambda c: None}).process_one() is False
    assert job(ctx, other).state == "queued"


def test_permanent_error_fails_without_retry(ctx: Ctx) -> None:
    def boom(c: JobContext) -> None:
        raise PermanentError("нет сайта у a@b.example")

    jid = enqueue(ctx)
    make_worker(ctx, {"t": boom}).process_one()
    j = job(ctx, jid)
    assert j.state == "failed" and j.attempts == 1
    assert "a@b.example" not in (j.last_error or "")


def test_retryable_error_requeues_with_backoff_then_fails_after_three(ctx: Ctx) -> None:
    def boom(c: JobContext) -> None:
        raise RetryableError("timeout")

    jid = enqueue(ctx)
    w = make_worker(ctx, {"t": boom})
    for attempt in (1, 2):
        w.process_one()
        j = job(ctx, jid)
        assert j.state == "queued" and j.attempts == attempt and j.run_after > ctx.clock.now()
        assert w.process_one() is False  # до истечения задержки задача не берётся
        ctx.clock.advance(4000)
    w.process_one()
    j = job(ctx, jid)
    assert j.state == "failed" and j.attempts == 3


def test_unexpected_exception_is_retryable_and_message_is_not_leaked(ctx: Ctx) -> None:
    def boom(c: JobContext) -> None:
        raise ValueError("секрет: ivan@example.com")

    jid = enqueue(ctx)
    make_worker(ctx, {"t": boom}).process_one()
    j = job(ctx, jid)
    assert j.state == "queued" and j.last_error == "Внутренняя ошибка: ValueError"


def test_cancel_during_run_between_steps(ctx: Ctx) -> None:
    jid = enqueue(ctx)
    steps: list[int] = []

    def handler(c: JobContext) -> None:
        c.check()
        steps.append(1)
        with ctx.db() as db:
            jobs.cancel(db, c.job_id)  # пользователь нажал «отмена»
        c.check()  # воркер замечает флаг между шагами
        steps.append(2)

    make_worker(ctx, {"t": handler}).process_one()
    assert steps == [1] and job(ctx, jid).state == "cancelled"


def test_graceful_stop_returns_job_to_queue_without_spending_attempt(ctx: Ctx) -> None:
    jid = enqueue(ctx)
    w = make_worker(ctx)

    def handler(c: JobContext) -> None:
        w.stop.set()  # SIGTERM пришёл посреди задачи
        c.check()

    w.handlers = {"t": handler}
    w.process_one()
    j = job(ctx, jid)
    assert (j.state, j.attempts, j.locked_by) == ("queued", 0, None)
    w.stop.clear()
    w.handlers = {"t": lambda c: {"ok": True}}
    w.process_one()
    assert job(ctx, jid).state == "succeeded"


def test_lost_job_does_not_overwrite_new_owner(ctx: Ctx) -> None:
    jid = enqueue(ctx)
    w = make_worker(ctx)
    timeout = ctx.settings.job_lock_timeout_seconds

    def handler(c: JobContext) -> None:
        ctx.clock.advance(timeout + 1)
        with ctx.db() as db:  # другой воркер забрал «зависшую» задачу
            assert jobs.claim(db, "other-worker", lock_timeout=timeout) is not None
        c.check()  # → JobInterrupted: задача больше не наша

    w.handlers = {"t": handler}
    w.process_one()
    j = job(ctx, jid)
    assert j.state == "running" and j.locked_by == "other-worker" and j.attempts == 2


def test_worker_restart_picks_up_orphaned_job(ctx: Ctx) -> None:
    jid = enqueue(ctx)
    with ctx.db() as db:
        assert jobs.claim(db, "old-worker#0", lock_timeout=300) is not None  # старый воркер умер
    fresh = make_worker(ctx, {"t": lambda c: {"attempt": c.attempts}})
    assert fresh.process_one() is False  # пока блокировка «жива»
    ctx.clock.advance(ctx.settings.job_lock_timeout_seconds + 1)
    assert fresh.process_one() is True
    j = job(ctx, jid)
    assert j.state == "succeeded" and j.result == {"attempt": 2}


def test_two_threads_process_each_job_once(ctx: Ctx) -> None:
    ids = [enqueue(ctx, {"n": i}) for i in range(12)]
    seen: list[int] = []
    lock = threading.Lock()

    def handler(c: JobContext) -> dict[str, int]:
        with lock:
            seen.append(c.payload["n"])
        time.sleep(0.01)
        return {"n": c.payload["n"]}

    settings = ctx.settings.model_copy(
        update={"worker_concurrency": 2, "worker_poll_seconds": 0.05}
    )
    w = Worker(settings, ctx.app.state.session_factory, handlers={"t": handler}, worker_id="t")
    t = threading.Thread(target=w.run)
    t.start()
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if all(job(ctx, i).state == "succeeded" for i in ids):
            break
        time.sleep(0.05)
    w.stop.set()
    t.join(timeout=15)
    assert not t.is_alive()
    assert sorted(seen) == list(range(12))  # каждая задача выполнена ровно один раз


def test_run_loop_survives_missing_tables_and_stops_on_signal(tmp_path: Path) -> None:
    url = (
        f"sqlite+pysqlite:///{tmp_path}/empty.db"  # схема не создана: миграции воркер не запускает
    )
    settings = Settings(
        database_url=url, worker_poll_seconds=0.05, worker_heartbeat_file=str(tmp_path / "hb")
    )
    w = Worker(settings, make_session_factory(make_engine(url)))
    t = threading.Thread(target=w.run)
    t.start()
    time.sleep(0.3)
    assert t.is_alive()  # ошибки БД не убивают процесс
    w.stop.set()
    t.join(timeout=15)
    assert not t.is_alive()


# --- heartbeat ------------------------------------------------------------------------------------------------


def test_heartbeat_file_and_healthcheck(
    ctx: Ctx, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    hb = tmp_path / "hb"
    settings = ctx.settings.model_copy(update={"worker_heartbeat_file": str(hb)})
    w = Worker(settings, ctx.app.state.session_factory, handlers={})
    assert heartbeat_ok(str(hb)) is False
    assert w.beat() is True and heartbeat_ok(str(hb)) is True
    old = time.time() - 600
    os.utime(hb, (old, old))
    assert heartbeat_ok(str(hb)) is False
    monkeypatch.setenv("WORKER_HEARTBEAT_FILE", str(hb))
    assert main(["--healthcheck"]) == 1
    w.beat()
    assert main(["--healthcheck"]) == 0


def test_beat_fails_when_db_unavailable(ctx: Ctx, tmp_path: Path) -> None:
    bad = make_session_factory(make_engine("sqlite+pysqlite:////nonexistent-dir/x.db"))
    settings = ctx.settings.model_copy(update={"worker_heartbeat_file": str(tmp_path / "hb")})
    assert Worker(settings, bad, handlers={}).beat() is False
    assert not (tmp_path / "hb").exists()


def test_concurrency_setting_is_limited() -> None:
    assert Settings(env="dev").worker_concurrency == 1
    with pytest.raises(ValueError):
        Settings(env="dev", worker_concurrency=3)


# --- enrich_company через воркер ------------------------------------------------------------------------------------------


def test_enrich_job_end_to_end_through_worker(ctx: Ctx) -> None:
    with LocalSite({"/robots.txt": Resp(status=404)}) as site:
        rich_site(site)
        cid = make_company(ctx, site)
        jid = enqueue(ctx, {"company_id": str(cid)}, job_type=ENRICH_COMPANY)
        w = make_worker(ctx, fetcher=fetcher_for(site))
        assert w.drain() == 1
    j = job(ctx, jid)
    assert j.state == "succeeded" and j.result is not None
    assert j.result["outcome"] == "checked" and j.result["score_after"] == 85
    assert "@" not in str(j.result)


def test_enrich_job_rerun_is_idempotent(ctx: Ctx) -> None:
    with LocalSite({"/robots.txt": Resp(status=404), "/": page("no_booking.html")}) as site:
        cid = make_company(ctx, site)
        w = make_worker(ctx, fetcher=fetcher_for(site))
        enqueue(ctx, {"company_id": str(cid)}, job_type=ENRICH_COMPANY)
        w.drain()
        with ctx.db() as db:
            first = len(db.scalars(select(CompanyFact)).all())
        enqueue(ctx, {"company_id": str(cid)}, job_type=ENRICH_COMPANY)
        w.drain()
        with ctx.db() as db:
            assert len(db.scalars(select(CompanyFact)).all()) == first


def test_enrich_job_for_company_without_site_fails_permanently(ctx: Ctx) -> None:
    cid = add_company(ctx, "Без сайта")
    jid = enqueue(ctx, {"company_id": str(cid)}, job_type=ENRICH_COMPANY)
    make_worker(ctx).process_one()
    j = job(ctx, jid)
    assert j.state == "failed" and j.attempts == 1 and "сайт" in (j.last_error or "")


def test_enrich_job_with_bad_payload_fails_permanently(ctx: Ctx) -> None:
    jid = enqueue(ctx, {"company_id": "not-a-uuid"}, job_type=ENRICH_COMPANY)
    make_worker(ctx).process_one()
    assert job(ctx, jid).state == "failed"


def test_enrich_job_cancelled_before_start_is_never_run(ctx: Ctx) -> None:
    with LocalSite({"/": page("no_booking.html")}) as site:
        cid = make_company(ctx, site)
        jid = enqueue(ctx, {"company_id": str(cid)}, job_type=ENRICH_COMPANY)
        with ctx.db() as db:
            jobs.cancel(db, jid)
        make_worker(ctx, fetcher=fetcher_for(site)).drain()
        assert site.log == [] and job(ctx, jid).state == "cancelled"
