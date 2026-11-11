"""Воркер очереди задач: `python -m app.worker` (ADR-017).

Опрашивает таблицу `jobs`, выполняет обработчики по типу, раз в 15 секунд обновляет файл-heartbeat
(для healthcheck контейнера). Мягкая остановка по SIGTERM/SIGINT: текущая задача возвращается в
очередь на ближайшей проверке. Миграции воркер НЕ запускает — их применяет контейнер API.
"""

from __future__ import annotations

import argparse
import logging
import os
import signal
import socket
import sys
import threading
import time
import uuid
from collections.abc import Callable
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from app.config import Settings
from app.db import make_engine, make_session_factory
from app.services import jobs
from app.services.job_handlers import HANDLERS, Handler, JobContext
from app.services.jobs import JobCancelled, JobInterrupted, PermanentError, RetryableError
from app.services.safe_fetch import SafeFetcher

log = logging.getLogger("leadhunter.worker")

HEARTBEAT_INTERVAL = 15.0
HEARTBEAT_MAX_AGE = 90.0
ERROR_PAUSE = 5.0


class Worker:
    def __init__(
        self,
        settings: Settings,
        session_factory: sessionmaker[Session],
        *,
        handlers: dict[str, Handler] | None = None,
        fetcher: SafeFetcher | None = None,
        worker_id: str | None = None,
        stop: threading.Event | None = None,
    ) -> None:
        self.settings = settings
        self.session_factory = session_factory
        self.handlers = handlers if handlers is not None else dict(HANDLERS)
        self.fetcher = fetcher or SafeFetcher(allow_private=settings.allow_private_fetch_for_tests)
        self.worker_id = (worker_id or f"{socket.gethostname()[:30]}:{os.getpid()}")[:56]
        self.stop = stop or threading.Event()

    # -- одна задача -----------------------------------------------------------------------

    def _make_check(self, job_id: uuid.UUID, wid: str) -> Callable[[], None]:
        def check() -> None:
            if self.stop.is_set():
                raise JobInterrupted("остановка воркера")
            with self.session_factory() as db:
                state = jobs.heartbeat(db, job_id, wid)
            if state == "cancel":
                raise JobCancelled("отмена пользователем")
            if state == "lost":
                raise JobInterrupted("задача больше не принадлежит воркеру")

        return check

    def _finish(self, action: Callable[[Session], object]) -> None:
        with self.session_factory() as db:
            action(db)

    def process_one(self, slot: int = 0) -> bool:
        """Берёт и выполняет одну задачу. True — задача была, False — очередь пуста."""
        wid = f"{self.worker_id}#{slot}"
        with self.session_factory() as db:
            job = jobs.claim(
                db,
                wid,
                types=sorted(self.handlers),
                lock_timeout=self.settings.job_lock_timeout_seconds,
            )
        if job is None:
            return False
        job_id = job.id
        handler = self.handlers[job.type]
        ctx = JobContext(
            job_id=job_id,
            job_type=job.type,
            payload=dict(job.payload or {}),
            attempts=job.attempts,
            max_attempts=job.max_attempts,
            created_by=job.created_by,
            settings=self.settings,
            session_factory=self.session_factory,
            fetcher=self.fetcher,
            check=self._make_check(job_id, wid),
        )
        log.info("job start id=%s type=%s attempt=%s", job_id, job.type, job.attempts)
        try:
            result = handler(ctx)
        except JobCancelled:
            self._finish(lambda db: jobs.mark_cancelled(db, job_id, wid))
            log.info("job cancelled id=%s", job_id)
        except JobInterrupted:
            self._finish(lambda db: jobs.release(db, job_id, wid))
            log.info("job released id=%s", job_id)
        except PermanentError as exc:
            msg = str(exc)
            self._finish(lambda db: jobs.fail(db, job_id, wid, msg, retryable=False))
            log.warning("job failed (permanent) id=%s", job_id)
        except RetryableError as exc:
            msg = str(exc)
            self._finish(lambda db: jobs.fail(db, job_id, wid, msg, retryable=True))
            log.warning("job failed (retryable) id=%s", job_id)
        except (
            Exception
        ) as exc:  # неожиданное: в журнал только тип ошибки (текст может содержать ПД)
            name = type(exc).__name__
            msg = f"Внутренняя ошибка: {name}"
            self._finish(lambda db: jobs.fail(db, job_id, wid, msg, retryable=True))
            log.error("job crashed id=%s error=%s", job_id, name)
        else:
            self._finish(lambda db: jobs.complete(db, job_id, wid, result))
            log.info("job done id=%s", job_id)
        return True

    # -- циклы ----------------------------------------------------------------------------

    def _loop(self, slot: int) -> None:
        while not self.stop.is_set():
            try:
                did = self.process_one(slot)
            except Exception as exc:
                log.warning("worker loop error=%s", type(exc).__name__)
                self.stop.wait(ERROR_PAUSE)
                continue
            if not did:
                self.stop.wait(self.settings.worker_poll_seconds)

    def drain(self, limit: int = 1000) -> int:
        """Выполняет задачи, пока очередь не опустеет (для `--once` и тестов)."""
        done = 0
        while done < limit and self.process_one():
            done += 1
        return done

    def beat(self) -> bool:
        """Heartbeat: БД отвечает → обновляем файл. False — БД недоступна."""
        try:
            with self.session_factory() as db:
                db.execute(text("SELECT 1"))
        except Exception:
            return False
        try:
            Path(self.settings.worker_heartbeat_file).write_text(str(int(time.time())))
        except OSError:
            return False
        return True

    def run(self) -> None:
        threads = [
            threading.Thread(target=self._loop, args=(i,), name=f"worker-{i}", daemon=True)
            for i in range(self.settings.worker_concurrency)
        ]
        self.beat()
        for t in threads:
            t.start()
        log.info("worker started id=%s concurrency=%s", self.worker_id, len(threads))
        while not self.stop.wait(HEARTBEAT_INTERVAL):
            if all(t.is_alive() for t in threads):
                self.beat()
        for t in threads:
            t.join(timeout=30)
        log.info("worker stopped")


def heartbeat_ok(path: str, max_age: float = HEARTBEAT_MAX_AGE) -> bool:
    try:
        age = time.time() - Path(path).stat().st_mtime
    except OSError:
        return False
    return age <= max_age


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.worker")
    parser.add_argument("--healthcheck", action="store_true", help="проверить heartbeat и выйти")
    parser.add_argument("--once", action="store_true", help="выполнить очередь и выйти")
    args = parser.parse_args(argv)
    settings = Settings()
    if args.healthcheck:
        return 0 if heartbeat_ok(settings.worker_heartbeat_file) else 1
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stdout,
    )
    engine = make_engine(settings.database_url)
    worker = Worker(settings, make_session_factory(engine))
    if args.once:
        worker.drain()
        return 0

    def _stop(signum: int, _frame: object) -> None:
        log.info("signal=%s: мягкая остановка", signum)
        worker.stop.set()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    worker.run()
    engine.dispose()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
