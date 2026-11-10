"""Режим ServerMind Credits для AI-чата: оценка стоимости, квоты, резерв и освобождение (ADR 0005).
Резерв/освобождение идут в ОТДЕЛЬНЫХ транзакциях: сбой провайдера откатывает сообщение пользователя (повтор не создаёт дублей),
но не оставляет «повисший» резерв. Списание (capture) выполняется в той же транзакции, что и ответ ассистента."""

from __future__ import annotations

import datetime as dt
import logging
import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import utcnow
from app.core.config import Settings
from app.core.permissions import ApiError
from app.core.security import decrypt
from app.db.models import PlatformModel
from app.db.session import _factory
from app.modules.billing import ledger
from app.modules.billing.ledger import LedgerError

log = logging.getLogger("servermind.credits")


def model_aad(model_id: uuid.UUID) -> bytes:
    """Контекст шифрования ключа платформенной модели: блоб нельзя «пересадить» в другую строку."""
    return f"platformmodel:{model_id}".encode()


@dataclass(frozen=True)
class PlatformAi:
    """Что используется для режима Credits: провайдер, модель, ключ, цены. Источник: админ-панель (БД) или, как запасной вариант, окружение."""
    provider: str
    model: str
    api_key: str = ""
    price_in: int = 0
    price_out: int = 0
    version: str = ""
    source: str = "db"

    def __repr__(self) -> str:  # ключ не попадает ни в логи, ни в трассировки
        return f"PlatformAi({self.provider}/{self.model}, source={self.source})"


def resolve_platform_ai(db: Session, s: Settings) -> PlatformAi | None:
    """Активная модель из админ-панели; если её нет — конфигурация из окружения (если полная); иначе None (режим недоступен)."""
    row = db.scalar(select(PlatformModel).where(PlatformModel.active.is_(True)).execution_options(populate_existing=True))
    if row is not None:
        try:
            key = decrypt(s.master_key_bytes, row.key_enc, model_aad(row.id)).decode()
        except Exception:  # noqa: BLE001 — нечитаемый ключ = модель недоступна, а не падение запроса
            log.error("platform model %s: key cannot be decrypted", row.id)
            return None
        return PlatformAi(row.provider, row.model, key, row.price_in_per_1k, row.price_out_per_1k, row.price_list_version, "db")
    if s.platform_ai_configured:
        return PlatformAi(s.platform_ai_provider, s.platform_ai_model, s.platform_ai_key, s.price_in_per_1k, s.price_out_per_1k,
                          s.price_list_version, "env")
    return None


def cost(tokens_in: int, tokens_out: int, pai: PlatformAi) -> int:
    """Стоимость в кредитах, округление вверх; только целочисленная арифметика."""
    return (max(tokens_in, 0) * pai.price_in + max(tokens_out, 0) * pai.price_out + 999) // 1000


def estimate_reserve(prompt_chars: int, pai: PlatformAi, s: Settings) -> int:
    """Консервативная оценка: 1 токен на 2 символа входа, полный лимит выходных токенов, на каждую из допустимых итераций.
    Это верхняя оценка; фактически списывается по токенам из ответа провайдера, остаток резерва возвращается."""
    per_call = cost(prompt_chars // 2 + 1, s.ai_max_output_tokens, pai)
    return max(per_call * s.ai_max_iterations, 1)


def check_caps(org_id: uuid.UUID, amount: int, s: Settings) -> None:
    now = utcnow()
    with _factory()() as db:
        if s.credits_daily_cap is not None and ledger.spent_since(db, org_id, now - dt.timedelta(days=1)) + amount > s.credits_daily_cap:
            raise ApiError(429, "credits_cap_daily", "Достигнут дневной лимит списаний. Повторите завтра или обратитесь к администратору.")
        if s.credits_monthly_cap is not None and ledger.spent_since(db, org_id, now - dt.timedelta(days=30)) + amount > s.credits_monthly_cap:
            raise ApiError(429, "credits_cap_monthly", "Достигнут месячный лимит списаний.")


def reserve_for_chat(org_id: uuid.UUID, user_id: uuid.UUID, message_id: uuid.UUID, amount: int) -> uuid.UUID:
    with _factory()() as db:
        try:
            res, _ = ledger.reserve(db, org_id, amount, key=f"chat:{message_id}:reserve", actor_id=user_id, note="Резерв под AI-запрос")
            db.commit()
            return res.id
        except LedgerError as e:
            db.rollback()
            if e.code == "insufficient_credits":
                raise ApiError(402, "insufficient_credits", "Недостаточно кредитов для этого запроса. Обратитесь к администратору или используйте свой ключ (BYOK).") from None
            raise ApiError(e.status, e.code, e.message) from None


def release_quiet(reservation_id: uuid.UUID, message_id: uuid.UUID) -> None:
    """Освобождение резерва при ошибке. Сама не падает: при сбое резерв подберёт воркер (release_stale)."""
    try:
        with _factory()() as db:
            ledger.release(db, reservation_id, key=f"chat:{message_id}:release", note="Запрос не выполнен: резерв освобождён")
            db.commit()
    except Exception:  # noqa: BLE001
        log.exception("release failed; stale sweeper will handle it")
