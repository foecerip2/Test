"""Фоновый цикл воркера внутри процесса API (один процесс, бюджет RAM 2–4 ГБ). Безопасно и при нескольких процессах:
захват заданий через FOR UPDATE SKIP LOCKED. Включается WORKER_ENABLED (по умолчанию да: в режиме репетиции воркер не
обращается к сети, только к БД)."""

from __future__ import annotations

import asyncio
import logging

from app.db.session import _factory
from app.modules.executor.runner import run_once

log = logging.getLogger("servermind.worker")


def tick() -> bool:
    with _factory()() as db:
        return run_once(db)


async def loop(poll_seconds: int) -> None:
    while True:
        try:
            busy = await asyncio.to_thread(tick)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — воркер не должен умирать из-за одного задания
            log.exception("job failed")
            busy = False
        if not busy:
            await asyncio.sleep(poll_seconds)
