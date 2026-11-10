"""Планы действий и подтверждение. В этой фазе подтверждение ТОЛЬКО фиксируется (approvals); исполнения нет — оно появится в Фазе 4
(worker перепроверит политику, срок, ревизию и хеш перед каждым изменяющим шагом)."""

from __future__ import annotations

import hmac
import uuid
from typing import Any

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.auth import AuthContext, client_ip, get_ctx, utcnow
from app.core.permissions import ApiError, require_role
from app.db.models import ActionPlan, Approval, Server
from app.db.session import get_db
from app.modules.audit import service as audit
from app.modules.policy.plan_hash import compute_hash, format_expires
from app.modules.servers.schemas import CamelModel

router = APIRouter(prefix="/action-plans", tags=["plans"])


class ApproveIn(CamelModel):
    hash: str
    revision: int


class StepIn(CamelModel):
    enabled: bool


def _iso(t: Any) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _load(db: Session, ctx: AuthContext, plan_id: str, *, lock: bool = False) -> ActionPlan:
    try:
        pid = uuid.UUID(plan_id)
    except ValueError:
        raise ApiError(404, "not_found", "План не найден.") from None
    q = select(ActionPlan).where(ActionPlan.id == pid, ActionPlan.organization_id == ctx.org_id)  # tenant — только из сессии
    plan = db.scalar(q.with_for_update() if lock else q)
    if plan is None:
        raise ApiError(404, "not_found", "План не найден.")
    if plan.status == "waiting_approval" and plan.expires_at <= utcnow():
        plan.status = "expired"
        audit.record(db, "plan.expired", org_id=ctx.org_id, target=str(plan.id))
        db.commit()
    return plan


def _recomputed(plan: ActionPlan) -> str:
    return compute_hash(str(plan.id), str(plan.server_id), plan.revision, format_expires(plan.expires_at), plan.steps)


def _out(db: Session, plan: ActionPlan) -> dict[str, Any]:
    srv = db.get(Server, plan.server_id)
    return {
        "id": str(plan.id), "serverId": str(plan.server_id), "serverName": srv.name if srv else "—", "revision": plan.revision,
        "title": plan.title, "summary": plan.summary, "steps": plan.steps, "downtime": plan.downtime, "createdAt": _iso(plan.created_at),
        "expiresAt": format_expires(plan.expires_at),  # ровно та строка, что входит в хеш
        "canonicalHash": plan.canonical_hash, "status": plan.status, "source": "ssh",
    }


@router.get("/{plan_id}")
def get_plan(plan_id: str, ctx: AuthContext = Depends(get_ctx()), db: Session = Depends(get_db)) -> dict[str, Any]:
    return _out(db, _load(db, ctx, plan_id))


@router.post("/{plan_id}/steps/{step_id}")
def toggle_step(plan_id: str, step_id: str, body: StepIn, request: Request, ctx: AuthContext = Depends(get_ctx()),
                db: Session = Depends(get_db)) -> dict[str, Any]:
    require_role(ctx, "operator")
    plan = _load(db, ctx, plan_id, lock=True)
    if plan.status != "waiting_approval":
        raise ApiError(409, "plan_closed", "План уже нельзя изменить.")
    steps = [dict(s) for s in plan.steps]
    step = next((s for s in steps if s["id"] == step_id), None)
    if step is None:
        raise ApiError(404, "not_found", "Шаг не найден.")
    if not step.get("optional"):
        raise ApiError(409, "step_required", "Обязательный шаг нельзя отключить.")
    step["enabled"] = body.enabled
    plan.steps = steps
    plan.revision += 1  # любое изменение → новая ревизия и новый хеш; прежнее подтверждение недействительно
    plan.canonical_hash = _recomputed(plan)
    audit.record(db, "plan.modified", org_id=ctx.org_id, actor_id=ctx.user.id, target=str(plan.id),
                 meta={"revision": plan.revision, "step": step_id, "enabled": body.enabled}, ip=client_ip(request))
    db.commit()
    return _out(db, plan)


@router.post("/{plan_id}/approve")
def approve(plan_id: str, body: ApproveIn, request: Request, ctx: AuthContext = Depends(get_ctx()), db: Session = Depends(get_db)) -> dict[str, Any]:
    require_role(ctx, "operator")  # подтверждать может только владелец/оператор
    plan = _load(db, ctx, plan_id, lock=True)
    if plan.status == "expired":
        raise ApiError(409, "plan_expired", "Срок действия плана истёк. Создайте план заново.")
    if plan.status != "waiting_approval":
        raise ApiError(409, "plan_closed", "План уже обработан.")
    if body.revision != plan.revision:
        raise ApiError(409, "revision_mismatch", "План изменился после просмотра. Проверьте его и подтвердите снова.")
    # хеш, который видел человек, должен совпасть и с сохранённым, и с пересчитанным по реальному содержимому (защита от подмены данных в БД)
    stored_ok = hmac.compare_digest(body.hash.encode(), plan.canonical_hash.encode())
    fresh_ok = hmac.compare_digest(_recomputed(plan).encode(), plan.canonical_hash.encode())
    if not stored_ok or not fresh_ok:
        audit.record(db, "plan.approval_refused", org_id=ctx.org_id, actor_id=ctx.user.id, target=str(plan.id),
                     meta={"reason": "hash_mismatch" if not stored_ok else "integrity"}, ip=client_ip(request))
        db.commit()
        raise ApiError(409, "hash_mismatch", "Хеш плана не совпал: подтверждение отклонено.")
    srv = db.get(Server, plan.server_id)
    if srv is None or srv.organization_id != ctx.org_id:
        raise ApiError(404, "not_found", "Сервер плана не найден.")
    db.add(Approval(organization_id=ctx.org_id, plan_id=plan.id, revision=plan.revision, canonical_hash=plan.canonical_hash, actor_user_id=ctx.user.id))
    plan.status = "approved"
    audit.record(db, "plan.approved", org_id=ctx.org_id, actor_id=ctx.user.id, target=str(plan.id),
                 meta={"revision": plan.revision, "hash": plan.canonical_hash}, ip=client_ip(request))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise ApiError(409, "plan_closed", "План уже подтверждён.") from None
    return {"planId": str(plan.id), "status": "approved", "revision": plan.revision, "hash": plan.canonical_hash,
            "executionAvailable": False,
            "message": "Подтверждение записано. Исполнитель ещё не подключён (Фаза 4): на сервере ничего не выполнено."}


@router.post("/{plan_id}/reject")
def reject(plan_id: str, request: Request, ctx: AuthContext = Depends(get_ctx()), db: Session = Depends(get_db)) -> dict[str, Any]:
    require_role(ctx, "operator")
    plan = _load(db, ctx, plan_id, lock=True)
    if plan.status != "waiting_approval":
        raise ApiError(409, "plan_closed", "План уже обработан.")
    plan.status = "rejected"
    audit.record(db, "plan.rejected", org_id=ctx.org_id, actor_id=ctx.user.id, target=str(plan.id), ip=client_ip(request))
    db.commit()
    return _out(db, plan)

