"""Фоновый цикл воркера внутри процесса API (один процесс, бюджет RAM 2–4 ГБ). Безопасно и при нескольких процессах:
захват заданий через FOR UPDATE SKIP LOCKED. Включается WORKER_ENABLED (по умолчанию да: в режиме репетиции воркер не
обращается к сети, только к БД)."""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
import time

from app.core.config import get_settings
from app.db.session import _factory
from app.modules.billing import ledger
from app.modules.executor.runner import run_once

log = logging.getLogger("servermind.worker")


_last_sweep = 0.0
SWEEP_EVERY_SECONDS = 60.0


def sweep_reservations() -> None:
    """Раз в минуту освобождает «повисшие» резервы кредитов (процесс упал между резервом и списанием)."""
    global _last_sweep
    now = time.monotonic()
    if now - _last_sweep < SWEEP_EVERY_SECONDS:
        return
    _last_sweep = now
    with _factory()() as db:
        n = ledger.release_stale(db, dt.timedelta(minutes=get_settings().stale_reservation_minutes))
    if n:
        log.warning("released %d stale credit reservations", n)


def tick() -> bool:
    sweep_reservations()
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
