"""Биллинг (кредиты) и административные функции закрытой беты. Организация — только из сессии. Админ-функции доступны лишь
пользователям из PLATFORM_ADMIN_EMAILS (для остальных — 404, существование эндпоинтов не раскрывается)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import AuthContext, client_ip, get_ctx
from app.core.config import get_settings
from app.core.permissions import ApiError
from app.db.models import AuditEvent, LedgerEntry, Membership, Organization, User
from app.db.session import get_db
from app.modules.audit import service as audit
from app.modules.billing import credits as credits_mod
from app.modules.billing import ledger
from app.modules.billing.ledger import LedgerError
from app.modules.servers.schemas import CamelModel

router = APIRouter(tags=["billing"])


def _iso(t: Any) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _signed(e: LedgerEntry) -> int:
    """Знак для показа: что произошло с доступным остатком (резерв уменьшает, освобождение возвращает)."""
    return -e.amount if e.kind in ("reserve", "capture") else e.amount


@router.get("/billing/balance")
def balance(ctx: AuthContext = Depends(get_ctx()), db: Session = Depends(get_db)) -> dict[str, Any]:
    s = get_settings()
    b = ledger.get_balance(db, ctx.org_id)
    org = db.get(Organization, ctx.org_id)
    return {"available": b.available, "reserved": b.held, "dailyCap": s.credits_daily_cap, "monthlyCap": s.credits_monthly_cap,
            "mode": org.ai_mode if org else "byok", "creditsConfigured": credits_mod.resolve_platform_ai(db, s) is not None,
            "unit": "кредитов (минимальных единиц)"}


@router.get("/billing/usage")
def usage(limit: int = Query(default=100, ge=1, le=200), ctx: AuthContext = Depends(get_ctx()), db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    rows = db.scalars(select(LedgerEntry).where(LedgerEntry.organization_id == ctx.org_id)
                      .order_by(LedgerEntry.created_at.desc(), LedgerEntry.id).limit(limit)).all()
    out = []
    for e in rows:
        item: dict[str, Any] = {"id": str(e.id), "at": _iso(e.created_at), "kind": e.kind, "amount": _signed(e), "note": e.note}
        if e.model:
            item.update({"model": e.model, "tokensIn": e.tokens_in, "tokensOut": e.tokens_out})
        out.append(item)
    return out


# ───────── администратор платформы ─────────
def require_platform_admin(ctx: AuthContext = Depends(get_ctx())) -> AuthContext:
    if ctx.user.email.lower() not in {e.lower() for e in get_settings().platform_admin_emails}:
        raise ApiError(404, "not_found", "Не найдено.")
    return ctx


class IssueIn(CamelModel):
    email: str = Field(min_length=3, max_length=254)
    amount: int = Field(ge=1, le=ledger.MAX_AMOUNT)
    reason: str = Field(min_length=3, max_length=200)
    idempotency_key: str = Field(min_length=8, max_length=80)


@router.post("/admin/credits/issue")
def issue_credits(body: IssueIn, request: Request, ctx: AuthContext = Depends(require_platform_admin), db: Session = Depends(get_db)) -> dict[str, Any]:
    user = db.scalar(select(User).where(User.email == body.email.strip().lower()))
    member = db.scalar(select(Membership).where(Membership.user_id == user.id, Membership.role == "owner")) if user else None
    if member is None:
        raise ApiError(404, "not_found", "Пользователь-владелец с таким email не найден.")
    try:
        entry, created = ledger.issue(db, member.organization_id, body.amount, key=body.idempotency_key, actor_id=ctx.user.id,
                                      note=f"Тестовые кредиты: {body.reason.strip()}")
    except LedgerError as e:
        db.rollback()
        raise ApiError(e.status, e.code, e.message) from None
    if created:  # повтор с тем же ключом не пишет второе событие аудита
        audit.record(db, "credits.issued", org_id=member.organization_id, actor_id=ctx.user.id, target=body.email.strip().lower(),
                     meta={"amount": body.amount, "reason": body.reason.strip(), "entry": str(entry.id)}, ip=client_ip(request))
    db.commit()
    return {"ok": True, "created": created, "available": ledger.get_balance(db, member.organization_id).available}


@router.get("/admin/audit")
def admin_audit(limit: int = Query(default=100, ge=1, le=500), _: AuthContext = Depends(require_platform_admin),
                db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    rows = db.scalars(select(AuditEvent).order_by(AuditEvent.id.desc()).limit(limit)).all()
    actors = {u.id: u.email for u in db.scalars(select(User).where(User.id.in_({r.actor_user_id for r in rows if r.actor_user_id}))).all()}
    return [{"id": str(r.id), "at": _iso(r.created_at), "actor": actors.get(r.actor_user_id, "система"), "action": r.action, "target": r.target}
            for r in rows]
