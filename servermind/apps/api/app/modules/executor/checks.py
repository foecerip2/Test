"""Перепроверка плана ПЕРЕД исполнением (ADR 0004, принцип 3). Не доверяем тому, что план был корректен при подтверждении:
состояние БД и сервера читается заново. Каждая проверка возвращает причину в понятном виде."""

from __future__ import annotations

import hmac
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import utcnow
from app.core.config import Settings
from app.db.models import ActionPlan, Approval, Membership, Server, ServerMetricSample
from app.modules.policy.engine import PolicyViolation, validate_proposal
from app.modules.policy.plan_hash import compute_hash, format_expires


@dataclass(frozen=True)
class Check:
    name: str
    ok: bool
    detail: str

    def as_dict(self) -> dict[str, Any]:
        return {"name": self.name, "ok": self.ok, "detail": self.detail}


def _enabled_steps(plan: ActionPlan) -> list[dict[str, Any]]:
    return [s for s in plan.steps if s.get("enabled", True)]


def preflight(db: Session, plan: ActionPlan, settings: Settings) -> list[Check]:
    """Проверки уровня плана. Порядок фиксирован; первая неудача останавливает исполнение (остальные всё равно вычисляются
    для отчёта, но исполнение шагов не начинается)."""
    # Сессия не сбрасывает кэш объектов после commit: перечитываем ВСЁ из БД, иначе перепроверка перед шагом увидит устаревшее состояние
    db.flush()
    db.expire_all()
    out: list[Check] = []
    out.append(Check("plan_approved", plan.status == "approved", "План подтверждён." if plan.status == "approved" else f"Статус плана «{plan.status}», нужен «approved»."))

    appr = db.scalar(select(Approval).where(Approval.plan_id == plan.id, Approval.revision == plan.revision,
                                            Approval.organization_id == plan.organization_id))
    appr_ok = appr is not None and hmac.compare_digest(appr.canonical_hash.encode(), plan.canonical_hash.encode())
    out.append(Check("approval_matches", appr_ok, "Подтверждение относится к текущей ревизии и хешу." if appr_ok
                     else "Нет подтверждения для текущей ревизии/хеша плана."))

    fresh = compute_hash(str(plan.id), str(plan.server_id), plan.revision, format_expires(plan.expires_at), plan.steps)
    integ = hmac.compare_digest(fresh.encode(), plan.canonical_hash.encode())
    out.append(Check("hash_integrity", integ, "Хеш пересчитан по содержимому и совпал." if integ else "Содержимое плана не соответствует хешу (возможна подмена)."))

    live = plan.expires_at > utcnow()
    out.append(Check("not_expired", live, "Срок действия подтверждения не истёк." if live else "Срок действия подтверждения истёк: создайте план заново."))

    if appr is not None:
        role = db.scalar(select(Membership.role).where(Membership.user_id == appr.actor_user_id,
                                                       Membership.organization_id == plan.organization_id))
        ok = role in ("owner", "operator")
        out.append(Check("approver_authorized", ok, "Подтвердивший сохраняет права owner/operator." if ok else "У подтвердившего больше нет прав owner/operator."))
    else:
        out.append(Check("approver_authorized", False, "Подтверждение не найдено."))

    server = db.get(Server, plan.server_id)
    srv_ok = server is not None and server.organization_id == plan.organization_id and server.status == "online" and bool(server.host_key_openssh)
    out.append(Check("server_ready", srv_ok, "Сервер онлайн, ключ хоста закреплён." if srv_ok else "Сервер не найден, не онлайн или нет закреплённого ключа хоста."))

    if server is not None and srv_ok:
        latest = db.scalar(select(ServerMetricSample).where(ServerMetricSample.server_id == server.id,
                                                            ServerMetricSample.organization_id == plan.organization_id)
                           .order_by(ServerMetricSample.sampled_at.desc()).limit(1))
        try:
            validate_proposal([{"tool": s["tool"], "params": s["params"]} for s in _enabled_steps(plan)],
                              server=server, latest=latest, role="operator", settings=settings)
            out.append(Check("policy", True, "Политика пройдена заново на текущих данных сервера."))
        except PolicyViolation as e:
            out.append(Check("policy", False, "; ".join(e.reasons)[:400]))
    else:
        out.append(Check("policy", False, "Пропущено: сервер не готов."))
    return out
