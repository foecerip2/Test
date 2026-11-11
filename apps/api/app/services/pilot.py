"""Заявки на пилот AutoFlow: приём (лимиты, дедупликация), список и правка для владельца.

Персональные данные (телефон, e-mail, имя) НЕ попадают в логи и журнал аудита:
в аудите только идентификатор заявки и признаки («есть телефон», «есть e-mail»).
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
import math
import uuid
from datetime import datetime, timedelta

import sqlalchemy as sa
from sqlalchemy import delete, or_, select
from sqlalchemy.orm import Session

from app import security
from app.config import Settings
from app.models import AuditLog, PilotRequest, RateLimitEvent
from app.pilot_schemas import PilotRequestIn, PilotRequestOut
from app.security import AppError

log = logging.getLogger("leadhunter.pilot")

HOUR = timedelta(hours=1)
DAY = timedelta(days=1)
SCOPE_IP = "pilot_ip"
SCOPE_ALL = "pilot_all"
GLOBAL_KEY = "all"
DEDUPE_WINDOW = DAY


def _limited(seconds: float) -> AppError:
    retry = max(1, math.ceil(seconds))
    return AppError(
        429,
        "RATE_LIMITED",
        "Слишком много заявок. Повторите позже.",
        headers={"Retry-After": str(retry)},
    )


def _events(db: Session, scope: str, key: str, since: datetime) -> list[datetime]:
    return list(
        db.scalars(
            select(RateLimitEvent.created_at)
            .where(
                RateLimitEvent.scope == scope,
                RateLimitEvent.key == key,
                RateLimitEvent.created_at > since,
            )
            .order_by(RateLimitEvent.created_at)
        )
    )


def _check(events: list[datetime], limit: int, window: timedelta, now: datetime) -> None:
    if len(events) >= limit:
        # Освободится место, когда самое старое из «блокирующих» событий выйдет из окна.
        oldest_blocking = events[len(events) - limit]
        raise _limited((oldest_blocking + window - now).total_seconds())


def enforce_limits(db: Session, settings: Settings, ip_hash: str) -> None:
    """Скользящие лимиты в БД: на IP-хэш (час, сутки) и общий (сутки). Бросает 429."""
    now = security.now()
    ip_events = _events(db, SCOPE_IP, ip_hash, now - DAY)
    _check([e for e in ip_events if e > now - HOUR], settings.pilot_ip_per_hour, HOUR, now)
    _check(ip_events, settings.pilot_ip_per_day, DAY, now)
    _check(_events(db, SCOPE_ALL, GLOBAL_KEY, now - DAY), settings.pilot_global_per_day, DAY, now)
    db.execute(
        delete(RateLimitEvent).where(
            RateLimitEvent.scope.in_((SCOPE_IP, SCOPE_ALL)),
            RateLimitEvent.created_at < now - 2 * DAY,
        )
    )
    db.add(RateLimitEvent(id=uuid.uuid4(), scope=SCOPE_IP, key=ip_hash, created_at=now))
    db.add(RateLimitEvent(id=uuid.uuid4(), scope=SCOPE_ALL, key=GLOBAL_KEY, created_at=now))


def ip_hash_for(settings: Settings, ip: str) -> str:
    return security.keyed_hash(settings, "pilot-ip", ip)


def short_user_agent(value: str | None) -> str | None:
    if not value:
        return None
    text = "".join(ch for ch in value if ch.isprintable())[:120].strip()
    return text or None


def is_duplicate(db: Session, data: PilotRequestIn, now: datetime) -> bool:
    conds = []
    if data.phone:
        conds.append(PilotRequest.phone == data.phone)
    if data.email:
        conds.append(PilotRequest.email == data.email)
    if not conds:
        return False
    found = db.scalar(
        select(PilotRequest.id)
        .where(PilotRequest.created_at > now - DEDUPE_WINDOW, or_(*conds))
        .limit(1)
    )
    return found is not None


def submit(
    db: Session, settings: Settings, data: PilotRequestIn, ip: str, user_agent: str | None
) -> None:
    """Принять заявку. Дубль (тот же контакт за 24 ч) молча не записывается: вызывающий
    отвечает одинаково в обоих случаях. Лимиты считаются и для дублей."""
    now = security.now()
    ip_hash = ip_hash_for(settings, ip)
    enforce_limits(db, settings, ip_hash)
    if is_duplicate(db, data, now):
        db.commit()  # сохраняем события лимитов
        log.info("Заявка на пилот: дубль отброшен")
        return
    row = PilotRequest(
        id=uuid.uuid4(),
        business_name=data.business_name,
        city=data.city,
        contact_name=data.contact_name,
        phone=data.phone,
        email=data.email,
        status="new",
        note="",
        consent_at=now,
        consent_text_version=data.consent_text_version or settings.pilot_consent_version,
        ip_hash=ip_hash,
        user_agent_short=short_user_agent(user_agent),
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    db.add(
        AuditLog(
            actor_id=None,
            action="pilot_request.created",
            entity="pilot_request",
            entity_id=str(row.id),
            meta={
                "has_phone": row.phone is not None,
                "has_email": row.email is not None,
                "consent_text_version": row.consent_text_version,
            },
        )
    )
    db.commit()
    log.info("Новая заявка на пилот id=%s", row.id)


def out(row: PilotRequest) -> PilotRequestOut:
    return PilotRequestOut.model_validate(
        {
            "id": row.id,
            "business_name": row.business_name,
            "city": row.city,
            "contact_name": row.contact_name,
            "phone": row.phone,
            "email": row.email,
            "status": row.status,
            "note": row.note,
            "consent_at": row.consent_at.isoformat(),
            "consent_text_version": row.consent_text_version,
            "created_at": row.created_at.isoformat(),
            "updated_at": row.updated_at.isoformat(),
        }
    )


def _encode_cursor(row: PilotRequest, status: str | None) -> str:
    raw = json.dumps(
        {"t": row.created_at.isoformat(), "i": str(row.id), "s": status}, separators=(",", ":")
    )
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def _decode_cursor(cursor: str, status: str | None) -> tuple[datetime, uuid.UUID]:
    try:
        d = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
        if not isinstance(d, dict) or d.get("s") != status:
            raise ValueError("cursor mismatch")
        t = datetime.fromisoformat(str(d["t"]))
        if t.tzinfo is None:
            raise ValueError("naive")
        return t, uuid.UUID(str(d["i"]))
    except (ValueError, KeyError, TypeError, binascii.Error) as exc:
        raise AppError(422, "INVALID_CURSOR", "Некорректный курсор. Обновите список.") from exc


def list_requests(
    db: Session, status: str | None, limit: int, cursor: str | None
) -> tuple[list[PilotRequest], str | None]:
    stmt = select(PilotRequest)
    if status:
        stmt = stmt.where(PilotRequest.status == status)
    if cursor:
        t, rid = _decode_cursor(cursor, status)
        stmt = stmt.where(
            sa.or_(
                PilotRequest.created_at < t,
                sa.and_(PilotRequest.created_at == t, PilotRequest.id < rid),
            )
        )
    stmt = stmt.order_by(PilotRequest.created_at.desc(), PilotRequest.id.desc()).limit(limit + 1)
    rows = list(db.scalars(stmt))
    has_more = len(rows) > limit
    rows = rows[:limit]
    return rows, (_encode_cursor(rows[-1], status) if has_more and rows else None)


def count_new(db: Session) -> int:
    n = db.scalar(
        select(sa.func.count()).select_from(PilotRequest).where(PilotRequest.status == "new")
    )
    return n or 0


def update_request(
    db: Session, actor_id: uuid.UUID, request_id: uuid.UUID, status: str | None, note: str | None
) -> PilotRequest:
    row = db.get(PilotRequest, request_id)
    if row is None:
        raise AppError(404, "NOT_FOUND", "Заявка не найдена.")
    meta: dict[str, object] = {}
    if status is not None and status != row.status:
        meta["status_from"] = row.status
        meta["status_to"] = status
        row.status = status
    if note is not None and note != row.note:
        meta["note_changed"] = True  # текст заметки в аудит не пишем
        row.note = note
    if meta:
        row.updated_at = security.now()
        db.add(
            AuditLog(
                actor_id=actor_id,
                action="pilot_request.update",
                entity="pilot_request",
                entity_id=str(row.id),
                meta=meta,
            )
        )
        db.commit()
    return row
