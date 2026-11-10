"""API исполнителя (режим «репетиция»). Подтверждённый план можно прогнать вхолостую: все проверки выполняются, на сервер
ничего не отправляется. Организация берётся только из сессии; чужое = 404."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.auth import AuthContext, get_ctx
from app.core.permissions import ApiError, require_role
from app.db.models import ActionPlan, Job, JobStep, Server, User
from app.db.session import get_db
from app.modules.executor import runner

router = APIRouter(tags=["executor"])


def _iso(t: Any) -> str | None:
    return t.strftime("%Y-%m-%dT%H:%M:%S.%fZ") if t else None


RISK_ORDER = ["R0", "R1", "R2", "R3", "R4", "R5"]


def _out(db: Session, job: Job, *, with_steps: bool) -> dict[str, Any]:
    srv = db.get(Server, job.server_id)
    plan = db.get(ActionPlan, job.plan_id)
    actor = db.get(User, job.requested_by) if job.requested_by else None
    enabled = [st for st in (plan.steps if plan else []) if st.get("enabled", True)]
    risk = max((st["risk"] for st in enabled), key=RISK_ORDER.index, default="R1")
    counts = dict(db.execute(select(JobStep.status, func.count()).where(JobStep.job_id == job.id).group_by(JobStep.status)).all())
    res: dict[str, Any] = {
        "title": f"Репетиция: {plan.title}" if plan else "Репетиция", "risk": risk, "actor": actor.name if actor else "—",
        "stepsTotal": len(enabled), "stepsDone": int(counts.get("rehearsed", 0)),
        "id": str(job.id), "planId": str(job.plan_id), "serverId": str(job.server_id), "serverName": srv.name if srv else "—",
        "mode": job.mode, "status": job.status, "summary": job.summary, "planRevision": job.plan_revision,
        "createdAt": _iso(job.created_at), "startedAt": _iso(job.started_at), "finishedAt": _iso(job.finished_at),
        "executesOnServer": False,  # в режиме репетиции — всегда false
    }
    if with_steps:
        rows = db.scalars(select(JobStep).where(JobStep.job_id == job.id, JobStep.organization_id == job.organization_id)
                          .order_by(JobStep.ord)).all()
        res["steps"] = [{"order": r.ord, "stepId": r.step_id, "tool": r.tool, "status": r.status, "checks": r.checks,
                         "plannedAction": r.planned_action, "at": _iso(r.created_at)} for r in rows]
    return res


def _plan_or_404(db: Session, ctx: AuthContext, plan_id: str) -> ActionPlan:
    try:
        pid = uuid.UUID(plan_id)
    except ValueError:
        raise ApiError(404, "not_found", "План не найден.") from None
    plan = db.scalar(select(ActionPlan).where(ActionPlan.id == pid, ActionPlan.organization_id == ctx.org_id).with_for_update())
    if plan is None:
        raise ApiError(404, "not_found", "План не найден.")
    return plan


@router.post("/action-plans/{plan_id}/rehearse")
def rehearse(plan_id: str, ctx: AuthContext = Depends(get_ctx()), db: Session = Depends(get_db)) -> JSONResponse:
    require_role(ctx, "operator")
    plan = _plan_or_404(db, ctx, plan_id)
    if plan.status != "approved":
        raise ApiError(409, "plan_not_approved", "Репетицию можно запустить только для подтверждённого плана.")
    try:
        job, created = runner.enqueue(db, plan, ctx.user.id)
        db.commit()
    except IntegrityError:  # гонка двух запросов: уникальный индекс гарантирует одну репетицию на ревизию
        db.rollback()
        plan = _plan_or_404(db, ctx, plan_id)
        job = db.scalar(select(Job).where(Job.plan_id == plan.id, Job.plan_revision == plan.revision, Job.mode == "rehearsal"))
        created = False
        if job is None:
            raise ApiError(409, "job_conflict", "Не удалось поставить задание в очередь.") from None
    return JSONResponse(_out(db, job, with_steps=True), status_code=202 if created else 200)


@router.get("/jobs")
def list_jobs(server_id: str | None = Query(default=None, alias="serverId"), limit: int = Query(default=30, ge=1, le=100),
              ctx: AuthContext = Depends(get_ctx()), db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    q = select(Job).where(Job.organization_id == ctx.org_id).order_by(Job.created_at.desc()).limit(limit)
    if server_id:
        try:
            q = q.where(Job.server_id == uuid.UUID(server_id))
        except ValueError:
            raise ApiError(404, "not_found", "Сервер не найден.") from None
    return [_out(db, j, with_steps=False) for j in db.scalars(q).all()]


@router.get("/jobs/{job_id}")
def get_job(job_id: str, ctx: AuthContext = Depends(get_ctx()), db: Session = Depends(get_db)) -> dict[str, Any]:
    try:
        jid = uuid.UUID(job_id)
    except ValueError:
        raise ApiError(404, "not_found", "Задание не найдено.") from None
    job = db.scalar(select(Job).where(Job.id == jid, Job.organization_id == ctx.org_id))
    if job is None:
        raise ApiError(404, "not_found", "Задание не найдено.")
    return _out(db, job, with_steps=True)
