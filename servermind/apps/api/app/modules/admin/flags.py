"""Флаги функций и kill switch платформы. Значения по умолчанию — здесь; изменения хранятся в БД (feature_flags) и аудируются.
Каждый флаг РЕАЛЬНО влияет на поведение (проверяется в соответствующем эндпоинте) — декоративных флагов нет."""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.db.models import FeatureFlag

# key → (название, описание, значение по умолчанию)
FLAGS: dict[str, tuple[str, str, bool]] = {
    "ai_chat": ("AI-чат", "Разрешает запросы к AI-ассистенту (собственные ключи, подписка и кредиты). Выключение останавливает чат у всех.", True),
    "credits_mode": ("Режим кредитов", "Разрешает организациям использовать AI-кредиты ServerMind. Выключение блокирует переключение и запросы в этом режиме.", True),
    "registration": ("Регистрация по приглашению", "Разрешает создавать аккаунты по пригласительным кодам закрытой беты.", True),
}
KILL = "kill_switch"  # enabled=True означает «исполнение остановлено»


def is_enabled(db: Session, key: str) -> bool:
    row = db.scalar(select(FeatureFlag).where(FeatureFlag.key == key).execution_options(populate_existing=True))
    return row.enabled if row is not None else FLAGS[key][2]


def set_value(db: Session, key: str, enabled: bool, actor_id: uuid.UUID | None) -> None:
    row = db.get(FeatureFlag, key, with_for_update=True)
    if row is None:
        db.add(FeatureFlag(key=key, enabled=enabled, updated_by=actor_id))
    else:
        row.enabled = enabled
        row.updated_by = actor_id
    db.flush()


def kill_engaged(db: Session) -> bool:
    row = db.scalar(select(FeatureFlag).where(FeatureFlag.key == KILL).execution_options(populate_existing=True))
    return bool(row and row.enabled)


def execution_allowed(db: Session, s: Settings) -> bool:
    """Исполнение разрешено, только если его допускает конфигурация сервера И kill switch не нажат."""
    return bool(s.execution_enabled) and not kill_engaged(db)
