"""Подключение AI-моделей платформы из админ-панели (режим Credits). ТОЛЬКО администратор платформы (PLATFORM_ADMIN_EMAILS,
сессия с пройденной 2FA); для остальных эндпоинтов «нет» (404). Ключ шифруется AEAD, наружу не отдаётся — только маска.
Это официальный API-доступ по ключу провайдера; вход под логином/паролем подписки не поддерживается намеренно."""

from __future__ import annotations

import re
import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import Field
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.auth import AuthContext, client_ip
from app.core.config import get_settings
from app.core.permissions import ApiError
from app.core.security import encrypt
from app.db.models import PlatformModel
from app.db.session import get_db
from app.modules.ai.providers import PROVIDERS
from app.modules.audit import service as audit
from app.modules.billing.credits import model_aad
from app.modules.billing.router import require_platform_admin
from app.modules.servers.schemas import CamelModel

router = APIRouter(prefix="/admin/models", tags=["admin-models"])
MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:\-]{0,63}$")
KEY_RE = re.compile(r"^[\x21-\x7e]{12,300}$")
MAX_PRICE = 10**9


class ModelIn(CamelModel):
    provider: Literal["openai", "anthropic", "deepseek"]
    model: str = Field(min_length=1, max_length=64)
    key: str = Field(min_length=12, max_length=300, repr=False)
    price_in: int = Field(ge=1, le=MAX_PRICE)    # кредитов за 1000 входных токенов — по прайс-листу провайдера, задаёт администратор
    price_out: int = Field(ge=1, le=MAX_PRICE)  # кредитов за 1000 выходных токенов
    price_list_version: str = Field(default="", max_length=40)
    skip_validation: bool = False


def _iso(t: Any) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def _out(m: PlatformModel) -> dict[str, Any]:
    return {"id": str(m.id), "provider": m.provider, "model": m.model, "masked": m.masked, "status": m.status, "active": m.active,
            "priceIn": m.price_in_per_1k, "priceOut": m.price_out_per_1k, "priceListVersion": m.price_list_version,
            "createdAt": _iso(m.created_at)}


def _get(db: Session, model_id: str, *, lock: bool = False) -> PlatformModel:
    try:
        mid = uuid.UUID(model_id)
    except ValueError:
        raise ApiError(404, "not_found", "Модель не найдена.") from None
    q = select(PlatformModel).where(PlatformModel.id == mid)
    row = db.scalar(q.with_for_update() if lock else q)
    if row is None:
        raise ApiError(404, "not_found", "Модель не найдена.")
    return row


@router.get("")
def list_models(ctx: AuthContext = Depends(require_platform_admin), db: Session = Depends(get_db)) -> dict[str, Any]:
    rows = db.scalars(select(PlatformModel).order_by(PlatformModel.created_at)).all()
    s = get_settings()
    return {"models": [_out(m) for m in rows], "envFallback": s.platform_ai_configured,
            "note": "Если активной модели нет, используется конфигурация из окружения (PLATFORM_AI_*), когда она полностью задана."}


@router.post("", status_code=201)
def add_model(body: ModelIn, request: Request, ctx: AuthContext = Depends(require_platform_admin), db: Session = Depends(get_db)) -> dict[str, Any]:
    key = body.key.strip()
    if not KEY_RE.fullmatch(key):
        raise ApiError(422, "validation", "Ключ содержит недопустимые символы или слишком короткий.")
    if not MODEL_RE.fullmatch(body.model):
        raise ApiError(422, "validation", "Некорректное имя модели.")
    if db.scalar(select(PlatformModel.id).where(PlatformModel.provider == body.provider, PlatformModel.model == body.model)):
        raise ApiError(409, "duplicate", "Такая модель уже подключена.")
    status = "unchecked"
    if not body.skip_validation:
        result = PROVIDERS[body.provider].validate_key(key, get_settings().ai_timeout_seconds)
        if result == "invalid":
            raise ApiError(422, "ai_key_invalid", "Провайдер отклонил ключ.")
        if result == "unavailable":
            raise ApiError(502, "ai_unavailable", "Не удалось проверить ключ: провайдер недоступен. Можно пропустить проверку.")
        status = "valid"
    mid = uuid.uuid4()
    has_active = db.scalar(select(PlatformModel.id).where(PlatformModel.active.is_(True))) is not None
    row = PlatformModel(id=mid, provider=body.provider, model=body.model, status=status, active=not has_active, masked=f"{key[:3]}••••{key[-4:]}",
                        key_enc=encrypt(get_settings().master_key_bytes, key.encode(), model_aad(mid)),
                        price_in_per_1k=body.price_in, price_out_per_1k=body.price_out,
                        price_list_version=body.price_list_version.strip(), created_by=ctx.user.id)
    db.add(row)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise ApiError(409, "duplicate", "Такая модель уже подключена.") from None
    audit.record(db, "platform_model.add", actor_id=ctx.user.id, target=f"{body.provider}/{body.model}",
                 meta={"status": status, "active": row.active}, ip=client_ip(request))
    db.commit()
    return _out(row)


@router.post("/{model_id}/activate")
def activate(model_id: str, request: Request, ctx: AuthContext = Depends(require_platform_admin), db: Session = Depends(get_db)) -> dict[str, Any]:
    row = _get(db, model_id, lock=True)
    if row.status == "invalid":
        raise ApiError(409, "model_invalid", "Ключ этой модели отклонён провайдером. Проверьте или замените его.")
    db.execute(update(PlatformModel).where(PlatformModel.id != row.id, PlatformModel.active.is_(True)).values(active=False))
    row.active = True
    audit.record(db, "platform_model.activate", actor_id=ctx.user.id, target=f"{row.provider}/{row.model}", ip=client_ip(request))
    db.commit()
    return _out(row)


@router.post("/{model_id}/check")
def check(model_id: str, request: Request, ctx: AuthContext = Depends(require_platform_admin), db: Session = Depends(get_db)) -> dict[str, Any]:
    """Проверка ключа запросом списка моделей у провайдера (без генерации текста)."""
    from app.core.security import decrypt  # noqa: PLC0415 — локально: используется только здесь

    row = _get(db, model_id)
    s = get_settings()
    try:
        key = decrypt(s.master_key_bytes, row.key_enc, model_aad(row.id)).decode()
    except Exception:  # noqa: BLE001
        raise ApiError(500, "crypto", "Не удалось расшифровать ключ модели.") from None
    result = PROVIDERS[row.provider].validate_key(key, s.ai_timeout_seconds)
    if result == "unavailable":
        raise ApiError(502, "ai_unavailable", "Провайдер недоступен: проверить ключ сейчас не удалось.")
    row.status = "valid" if result == "valid" else "invalid"
    audit.record(db, "platform_model.check", actor_id=ctx.user.id, target=f"{row.provider}/{row.model}", meta={"status": row.status}, ip=client_ip(request))
    db.commit()
    return _out(row)


@router.delete("/{model_id}")
def delete(model_id: str, request: Request, ctx: AuthContext = Depends(require_platform_admin), db: Session = Depends(get_db)) -> dict[str, bool]:
    row = _get(db, model_id, lock=True)
    audit.record(db, "platform_model.delete", actor_id=ctx.user.id, target=f"{row.provider}/{row.model}", meta={"was_active": row.active}, ip=client_ip(request))
    db.delete(row)
    db.commit()
    return {"ok": True}
