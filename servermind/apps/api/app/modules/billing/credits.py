"""Режим ServerMind Credits для AI-чата: оценка стоимости, квоты, резерв и освобождение (ADR 0005).
Резерв/освобождение идут в ОТДЕЛЬНЫХ транзакциях: сбой провайдера откатывает сообщение пользователя (повтор не создаёт дублей),
но не оставляет «повисший» резерв. Списание (capture) выполняется в той же транзакции, что и ответ ассистента."""

from __future__ import annotations

import datetime as dt
import logging
import uuid

from app.core.auth import utcnow
from app.core.config import Settings
from app.core.permissions import ApiError
from app.db.session import _factory
from app.modules.billing import ledger
from app.modules.billing.ledger import LedgerError

log = logging.getLogger("servermind.credits")


def cost(tokens_in: int, tokens_out: int, s: Settings) -> int:
    """Стоимость в кредитах, округление вверх; только целочисленная арифметика."""
    return (max(tokens_in, 0) * s.price_in_per_1k + max(tokens_out, 0) * s.price_out_per_1k + 999) // 1000


def estimate_reserve(prompt_chars: int, s: Settings) -> int:
    """Консервативная оценка: 1 токен на 2 символа входа, полный лимит выходных токенов, на каждую из допустимых итераций.
    Это верхняя оценка; фактически списывается по токенам из ответа провайдера, остаток резерва возвращается."""
    per_call = cost(prompt_chars // 2 + 1, s.ai_max_output_tokens, s)
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
