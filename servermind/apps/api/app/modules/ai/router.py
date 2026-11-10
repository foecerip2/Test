from __future__ import annotations

import re
import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Request
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import AuthContext, client_ip, get_ctx
from app.core.config import get_settings
from app.core.permissions import ApiError, get_server_or_404, require_role
from app.core.security import encrypt
from app.db.models import AiKey, Message, Organization
from app.db.session import get_db
from app.modules.ai import service
from app.modules.ai.providers import PROVIDERS
from app.modules.audit import service as audit
from app.modules.servers.schemas import CamelModel

router = APIRouter(tags=["ai"])
MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:\-]{0,63}$")
KEY_RE = re.compile(r"^[\x21-\x7e]{12,300}$")  # печатные ASCII без пробелов


class AiKeyIn(CamelModel):
    provider: Literal["openai", "anthropic", "deepseek"]
    key: str = Field(min_length=12, max_length=300, repr=False)
    model: str = Field(min_length=1, max_length=64)  # имя модели задаёт пользователь: список моделей у провайдеров меняется
    skip_validation: bool = False


class AiKeyOut(CamelModel):
    id: str
    provider: str
    masked: str
    model: str
    created_at: str
    status: str


class ModeBody(CamelModel):
    mode: Literal["byok", "credits"]


class MessageIn(CamelModel):
    server_id: str
    text: str = Field(min_length=1, max_length=service.MAX_USER_TEXT + 100)


def _mask(key: str) -> str:
    return f"{key[:3]}••••{key[-4:]}"


def _out(k: AiKey) -> AiKeyOut:
    return AiKeyOut(id=str(k.id), provider=k.provider, masked=k.masked, model=k.model, status=k.status,
                    created_at=k.created_at.strftime("%Y-%m-%dT%H:%M:%SZ"))


@router.get("/ai-keys", response_model=list[AiKeyOut])
def list_keys(ctx: AuthContext = Depends(get_ctx()), db: Session = Depends(get_db)) -> list[AiKeyOut]:
    rows = db.scalars(select(AiKey).where(AiKey.organization_id == ctx.org_id).order_by(AiKey.created_at)).all()
    return [_out(k) for k in rows]


@router.post("/ai-keys", response_model=AiKeyOut, status_code=201)
def add_key(body: AiKeyIn, request: Request, ctx: AuthContext = Depends(get_ctx()), db: Session = Depends(get_db)) -> AiKeyOut:
    require_role(ctx, "owner")  # секреты провайдеров — только владелец
    key = body.key.strip()
    if not KEY_RE.fullmatch(key):
        raise ApiError(422, "validation", "Ключ содержит недопустимые символы или слишком короткий.")
    if not MODEL_RE.fullmatch(body.model):
        raise ApiError(422, "validation", "Некорректное имя модели.")
    if db.scalar(select(AiKey.id).where(AiKey.organization_id == ctx.org_id, AiKey.provider == body.provider)):
        raise ApiError(409, "duplicate", "Ключ этого провайдера уже подключён. Удалите его и добавьте новый.")
    status = "unchecked"
    if not body.skip_validation:
        result = PROVIDERS[body.provider].validate_key(key, get_settings().ai_timeout_seconds)
        if result == "invalid":
            raise ApiError(422, "ai_key_invalid", "Провайдер отклонил ключ.")
        if result == "unavailable":
            raise ApiError(502, "ai_unavailable", "Не удалось проверить ключ: провайдер недоступен. Можно пропустить проверку.")
        status = "valid"
    row = AiKey(organization_id=ctx.org_id, created_by=ctx.user.id, provider=body.provider, model=body.model, status=status, masked=_mask(key),
                key_enc=encrypt(get_settings().master_key_bytes, key.encode(), service.key_aad(ctx.org_id, body.provider)))
    db.add(row)
    db.flush()
    audit.record(db, "ai_key.add", org_id=ctx.org_id, actor_id=ctx.user.id, target=body.provider, meta={"model": body.model, "status": status},
                 ip=client_ip(request))
    db.commit()
    return _out(row)


@router.delete("/ai-keys/{key_id}")
def delete_key(key_id: str, request: Request, ctx: AuthContext = Depends(get_ctx()), db: Session = Depends(get_db)) -> dict[str, bool]:
    require_role(ctx, "owner")
    try:
        kid = uuid.UUID(key_id)
    except ValueError:
        raise ApiError(404, "not_found", "Ключ не найден.") from None
    row = db.scalar(select(AiKey).where(AiKey.id == kid, AiKey.organization_id == ctx.org_id))
    if row is None:
        raise ApiError(404, "not_found", "Ключ не найден.")
    audit.record(db, "ai_key.delete", org_id=ctx.org_id, actor_id=ctx.user.id, target=row.provider, ip=client_ip(request))
    db.delete(row)
    db.commit()
    return {"ok": True}


@router.get("/billing/mode")
def get_mode(ctx: AuthContext = Depends(get_ctx()), db: Session = Depends(get_db)) -> dict[str, str]:
    org = db.get(Organization, ctx.org_id)
    return {"mode": org.ai_mode if org else "byok"}


@router.put("/billing/mode")
def set_mode(body: ModeBody, ctx: AuthContext = Depends(get_ctx()), db: Session = Depends(get_db)) -> dict[str, str]:
    require_role(ctx, "owner")
    if body.mode == "credits":
        raise ApiError(409, "mode_unavailable", "Режим кредитов появится в Фазе 5. Сейчас доступны только собственные ключи (BYOK).")
    return {"mode": "byok"}


@router.get("/conversations")
def history(server: str = Query(...), ctx: AuthContext = Depends(get_ctx()), db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    srv = get_server_or_404(db, ctx, server)
    conv = service.get_conversation(db, ctx, srv)
    rows = db.scalars(select(Message).where(Message.conversation_id == conv.id, Message.organization_id == ctx.org_id)
                      .order_by(Message.created_at).limit(200)).all()
    db.commit()
    return [service.to_chat_message(m) for m in rows]


@router.post("/conversations/messages")
def send(body: MessageIn, ctx: AuthContext = Depends(get_ctx()), db: Session = Depends(get_db)) -> list[dict[str, Any]]:
    srv = get_server_or_404(db, ctx, body.server_id)
    user_msg, assistant = service.run_chat(db, ctx, srv, body.text)
    return [service.to_chat_message(user_msg), service.to_chat_message(assistant)]
