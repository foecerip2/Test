"""Очередь и прогон заданий. РЕЖИМ ТОЛЬКО «РЕПЕТИЦИЯ»: все проверки выполняются, текст операций формируется, но НИКАКОГО
подключения к серверам нет (в модуле нет импорта SSH). Реальное исполнение в этой версии отсутствует и CHECK в БД
не позволяет создать задание другого режима."""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import utcnow
from app.core.config import Settings, get_settings
from app.db.models import ActionPlan, Job, JobStep
from app.modules.audit import service as audit
from app.modules.executor import ops
from app.modules.executor.checks import Check, preflight

LEASE_SECONDS = 120


def enqueue(db: Session, plan: ActionPlan, actor_id: uuid.UUID) -> tuple[Job, bool]:
    """Идемпотентно: одна репетиция на (план, ревизия). Возвращает (задание, создано_ли_сейчас)."""
    existing = db.scalar(select(Job).where(Job.plan_id == plan.id, Job.plan_revision == plan.revision, Job.mode == "rehearsal"))
    if existing is not None:
        return existing, False
    job = Job(organization_id=plan.organization_id, plan_id=plan.id, server_id=plan.server_id, plan_revision=plan.revision,
              plan_hash=plan.canonical_hash, mode="rehearsal", status="queued", requested_by=actor_id)
    db.add(job)
    audit.record(db, "job.queued", org_id=plan.organization_id, actor_id=actor_id, target=str(plan.id),
                 meta={"mode": "rehearsal", "revision": plan.revision})
    db.flush()
    return job, True


def claim_next(db: Session, *, now: dt.datetime | None = None) -> Job | None:
    """Захват одного задания (FOR UPDATE SKIP LOCKED): несколько воркеров не возьмут одно и то же. Просроченная аренда
    (воркер упал) возвращает задание в очередь."""
    now = now or utcnow()
    job = db.scalar(select(Job).where(
        (Job.status == "queued") | ((Job.status == "running") & (Job.lease_until < now))
    ).order_by(Job.created_at).limit(1).with_for_update(skip_locked=True))
    if job is None:
        return None
    job.status = "running"
    job.started_at = now
    job.lease_until = now + dt.timedelta(seconds=LEASE_SECONDS)
    db.commit()
    return job


def _step(db: Session, job: Job, ord_: int, step: dict[str, Any], status: str, checks: list[Check], planned: str) -> None:
    db.add(JobStep(organization_id=job.organization_id, job_id=job.id, ord=ord_, step_id=str(step.get("id", ""))[:16],
                   tool=str(step.get("tool", ""))[:48], status=status, checks=[c.as_dict() for c in checks], planned_action=planned))


def process(db: Session, job: Job, settings: Settings | None = None) -> Job:
    """Прогон репетиции. Повторная проверка выполняется ПЕРЕД КАЖДЫМ шагом (в реальном режиме между шагами могло пройти время)."""
    settings = settings or get_settings()
    plan = db.get(ActionPlan, job.plan_id)
    if plan is None or plan.organization_id != job.organization_id or plan.revision != job.plan_revision \
            or plan.canonical_hash != job.plan_hash:
        _finish(db, job, "blocked", "План изменился после постановки задания: репетиция отменена.")
        return job
    steps = [s for s in plan.steps if s.get("enabled", True)]
    stopped = ""
    for ord_, step in enumerate(steps, start=1):
        if stopped:
            _step(db, job, ord_, step, "skipped", [], "")
            continue
        checks = preflight(db, plan, settings)
        failed = [c for c in checks if not c.ok]
        if failed:
            _step(db, job, ord_, step, "blocked", checks, "")
            stopped = failed[0].detail
            continue
        if step["tool"] not in ops.SUPPORTED:
            checks = [*checks, Check("operation_supported", False, "Эта операция ещё не включена в исполнитель (ADR 0004, п. 4).")]
            _step(db, job, ord_, step, "blocked", checks, "")
            stopped = f"Операция {step['tool']} ещё не поддерживается исполнителем."
            continue
        try:
            planned = ops.render(step["tool"], step["params"])
        except ops.OpError as e:
            _step(db, job, ord_, step, "failed", [*checks, Check("render", False, str(e))], "")
            stopped = str(e)
            continue
        _step(db, job, ord_, step, "rehearsed", [*checks, Check("operation_supported", True, "Операция входит в первую версию исполнителя.")], planned)
    if stopped:
        _finish(db, job, "blocked", f"Репетиция остановлена: {stopped}"[:255])
    else:
        _finish(db, job, "succeeded", f"Репетиция пройдена: {len(steps)} шаг(ов). Реальное исполнение выключено, на сервере ничего не выполнялось.")
    return job


def _finish(db: Session, job: Job, status: str, summary: str) -> None:
    job.status = status
    job.summary = summary
    job.finished_at = utcnow()
    job.lease_until = None
    audit.record(db, "job.finished", org_id=job.organization_id, target=str(job.plan_id), meta={"mode": job.mode, "status": status})
    db.commit()


def run_once(db: Session) -> bool:
    """Берёт одно задание и обрабатывает. Возвращает True, если работа была."""
    job = claim_next(db)
    if job is None:
        return False
    try:
        process(db, job)
    except Exception:  # noqa: BLE001 — любое падение = задание failed, воркер продолжает жить
        db.rollback()
        j = db.get(Job, job.id)
        if j is not None:
            _finish(db, j, "failed", "Внутренняя ошибка при репетиции; подробности в журнале сервера.")
        raise
    return True
