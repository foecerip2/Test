"""Проверки на реальной PostgreSQL: миграции вверх/вниз и SKIP LOCKED.

Включаются переменной TEST_POSTGRES_URL (например postgresql+psycopg://postgres@/lh?host=/var/tmp/lhpg);
без неё пропускаются. База будет очищена (drop schema public).
"""

from __future__ import annotations

import os
import threading
import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.db import Base, make_session_factory
from app.models import Job
from app.services import jobs

URL = os.environ.get("TEST_POSTGRES_URL", "")
pytestmark = pytest.mark.skipif(not URL, reason="TEST_POSTGRES_URL не задан")
API_DIR = Path(__file__).resolve().parent.parent
ALL_TABLES = {
    "users", "otp_challenges", "sessions", "audit_logs", "rate_limits", "companies",
    "company_facts", "lead_scores", "import_jobs", "activity_events", "jobs", "campaigns",
}  # fmt: skip


def _cfg() -> Config:
    cfg = Config()
    cfg.set_main_option("script_location", str(API_DIR / "alembic"))
    cfg.set_main_option("sqlalchemy.url", URL.replace("%", "%%"))
    return cfg


def _reset() -> sa.Engine:
    engine = sa.create_engine(URL)
    with engine.begin() as c:
        c.execute(sa.text("DROP SCHEMA public CASCADE"))
        c.execute(sa.text("CREATE SCHEMA public"))
    return engine


def _tables(engine: sa.Engine) -> set[str]:
    return set(sa.inspect(engine).get_table_names()) - {"alembic_version"}


def test_migrations_up_down_up_and_schema_matches_models() -> None:
    engine = _reset()
    cfg = _cfg()
    command.upgrade(cfg, "head")
    assert _tables(engine) == ALL_TABLES
    with engine.connect() as conn:
        assert conn.execute(sa.text("SELECT version_num FROM alembic_version")).scalar() == "0003"
        ctx = MigrationContext.configure(conn, opts={"compare_type": False})
        assert compare_metadata(ctx, Base.metadata) == []
        cols = dict(
            conn.execute(
                sa.text(
                    "SELECT column_name, data_type FROM information_schema.columns"
                    " WHERE table_name = 'jobs'"
                )
            ).all()
        )
        assert cols["payload"] == "jsonb" and cols["run_after"] == "timestamp with time zone"
        idx = dict(
            conn.execute(
                sa.text("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'jobs'")
            ).all()
        )
        assert "(state, run_after)" in idx["ix_jobs_state_run_after"]
        assert "WHERE" in idx["uq_jobs_active_dedupe"]
    command.downgrade(cfg, "0002")
    assert _tables(engine) == ALL_TABLES - {"jobs", "campaigns"}
    with engine.connect() as conn:
        facts_cols = {c["name"] for c in sa.inspect(conn).get_columns("company_facts")}
    assert "source" not in facts_cols and "fact_key" not in facts_cols
    command.downgrade(cfg, "base")
    assert _tables(engine) == set()
    command.upgrade(cfg, "head")
    assert _tables(engine) == ALL_TABLES
    engine.dispose()


@pytest.fixture
def factory() -> Iterator[sessionmaker[Session]]:
    engine = _reset()
    command.upgrade(_cfg(), "head")
    engine.dispose()
    engine = sa.create_engine(URL, pool_size=12, max_overflow=4)
    yield make_session_factory(engine)
    engine.dispose()


def test_claim_statement_uses_skip_locked(factory: sessionmaker[Session]) -> None:
    stmt = sa.select(Job.id).where(Job.state == "queued").limit(1).with_for_update(skip_locked=True)
    with factory() as s:
        sql = str(stmt.compile(s.get_bind()))
    assert "FOR UPDATE SKIP LOCKED" in sql


def test_locked_row_is_skipped_not_waited_for(factory: sessionmaker[Session]) -> None:
    with factory() as s:
        a = jobs.enqueue(s, "t", {}, commit=True)
        b = jobs.enqueue(s, "t", {}, commit=True)
    holder = factory()
    holder.execute(sa.select(Job.id).where(Job.id == a.id).with_for_update())  # блокировка строки
    try:
        with factory() as s:
            got = jobs.claim(s, "w")
        assert got is not None and got.id == b.id  # не ждёт и не берёт чужую строку
    finally:
        holder.rollback()
        holder.close()
    with factory() as s:
        got2 = jobs.claim(s, "w2")
    assert got2 is not None and got2.id == a.id


def test_concurrent_claim_each_job_exactly_once(factory: sessionmaker[Session]) -> None:
    n_jobs, n_threads = 120, 8
    with factory() as s:
        ids = {jobs.enqueue(s, "t", {"i": i}).id for i in range(n_jobs)}
        s.commit()
    claimed: list[uuid.UUID] = []
    per_thread: dict[int, int] = {}
    lock = threading.Lock()
    start = threading.Barrier(n_threads)

    def worker(n: int) -> None:
        start.wait()
        with factory() as s:
            while (got := jobs.claim(s, f"w{n}")) is not None:
                with lock:
                    claimed.append(got.id)
                    per_thread[n] = per_thread.get(n, 0) + 1

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n_threads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(claimed) == n_jobs and set(claimed) == ids
    with factory() as s:
        rows = s.scalars(sa.select(Job)).all()
        assert all(r.state == "running" and r.attempts == 1 for r in rows)
    print("claims per thread:", sorted(per_thread.values()))


def test_one_job_sixteen_threads_single_winner(factory: sessionmaker[Session]) -> None:
    with factory() as s:
        jobs.enqueue(s, "t", {}, commit=True)
    barrier = threading.Barrier(16)
    winners: list[str] = []
    lock = threading.Lock()

    def worker(n: int) -> None:
        with factory() as s:
            barrier.wait()
            got = jobs.claim(s, f"w{n}")
            if got is not None:
                with lock:
                    winners.append(got.locked_by or "")

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(16)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(winners) == 1


def test_active_dedupe_index_enforced_by_database(factory: sessionmaker[Session]) -> None:
    with factory() as s:
        jobs.enqueue(s, "t", {}, dedupe_key="k", commit=True)
        s.add(Job(type="t", payload={}, dedupe_key="k"))
        with pytest.raises(IntegrityError):
            s.commit()
        s.rollback()
        with pytest.raises(jobs.DuplicateJobError):
            jobs.enqueue(s, "t", {}, dedupe_key="k")


def test_concurrent_enqueue_same_key_one_row(factory: sessionmaker[Session]) -> None:
    barrier = threading.Barrier(8)
    outcomes: list[str] = []
    lock = threading.Lock()

    def worker() -> None:
        with factory() as s:
            barrier.wait()
            try:
                jobs.enqueue(s, "t", {}, dedupe_key="same", commit=True)
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
    assert outcomes.count("created") == 1
    with factory() as s:
        assert s.scalar(sa.select(sa.func.count()).select_from(Job)) == 1


def test_utf8_roundtrip_in_jsonb_and_errors(factory: sessionmaker[Session]) -> None:
    with factory() as s:
        j = jobs.enqueue(s, "t", {"имя": "Север Авто «№1»"}, commit=True)
        assert jobs.claim(s, "w") is not None
        jobs.fail(s, j.id, "w", "Ошибка: сайт недоступен", retryable=False)
        s.expire_all()
        row = jobs.get_job(s, j.id)
        assert row.payload == {"имя": "Север Авто «№1»"}
        assert row.last_error == "Ошибка: сайт недоступен"
