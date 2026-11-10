"""Аудит. Запись append-only (UPDATE/DELETE запрещены триггером). Секреты в meta не пишутся."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.orm import Session

from app.core.security import redact
from app.db.models import AuditEvent

_FORBIDDEN_KEYS = {"password", "secret", "token", "key", "private_key", "totp", "code", "authorization"}


def _clean(meta: dict[str, Any] | None) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in (meta or {}).items():
        if k.lower() in _FORBIDDEN_KEYS:
            continue
        out[k] = redact(v) if isinstance(v, str) else v
    return out


def record(
    db: Session, action: str, *, org_id: uuid.UUID | None = None, actor_id: uuid.UUID | None = None,
    target: str = "", meta: dict[str, Any] | None = None, ip: str = "",
) -> None:
    db.add(AuditEvent(organization_id=org_id, actor_user_id=actor_id, action=action, target=redact(target)[:255],
                      meta=_clean(meta), ip=ip))
