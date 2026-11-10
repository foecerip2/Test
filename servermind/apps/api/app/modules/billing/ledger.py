"""Кредитный ledger (ADR 0005). Деньги/кредиты — целые минимальные единицы.

Инварианты (проверяются и тестами, и ограничениями БД):
- баланс и доступный остаток никогда не отрицательны (CHECK в wallets);
- каждая операция идемпотентна по (organization_id, idempotency_key): повтор не меняет баланс;
- резерв закрывается ровно один раз (open → captured | released);
- проводки неизменяемы (триггер БД); кошелёк — кэш суммы проводок, сверяется функцией verify().
Все операции сериализуются блокировкой строки кошелька организации. Функции только flush-ят: commit — за вызывающим."""

from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.core.auth import utcnow
from app.db.models import LedgerEntry, Reservation, Wallet

MAX_AMOUNT = 10**12


class LedgerError(Exception):
    def __init__(self, code: str, message: str, status: int = 409) -> None:
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


@dataclass(frozen=True)
class Balance:
    balance: int
    held: int

    @property
    def available(self) -> int:
        return self.balance - self.held


def _lock_wallet(db: Session, org_id: uuid.UUID) -> Wallet:
    db.execute(pg_insert(Wallet).values(organization_id=org_id, balance=0, held=0).on_conflict_do_nothing(index_elements=["organization_id"]))
    w = db.scalar(select(Wallet).where(Wallet.organization_id == org_id).with_for_update().execution_options(populate_existing=True))
    assert w is not None
    return w


def _check_amount(amount: int, *, signed: bool = False) -> None:
    if isinstance(amount, bool) or not isinstance(amount, int) or amount == 0 or abs(amount) > MAX_AMOUNT or (amount < 0 and not signed):
        raise LedgerError("bad_amount", "Сумма должна быть целым положительным числом (в минимальных единицах).", 422)


def _check_key(key: str) -> str:
    if not isinstance(key, str) or not (8 <= len(key) <= 80) or not key.isprintable():
        raise LedgerError("bad_idempotency_key", "Ключ идемпотентности: от 8 до 80 печатаемых символов.", 422)
    return key


def _existing(db: Session, org_id: uuid.UUID, key: str) -> LedgerEntry | None:
    return db.scalar(select(LedgerEntry).where(LedgerEntry.organization_id == org_id, LedgerEntry.idempotency_key == key)
                     .execution_options(populate_existing=True))


def _same(e: LedgerEntry, kind: str, amount: int, reservation_id: uuid.UUID | None = None) -> None:
    if e.kind != kind or e.amount != amount or (reservation_id is not None and e.reservation_id != reservation_id):
        raise LedgerError("idempotency_conflict", "Этот ключ идемпотентности уже использован для другой операции.")


def _entry(db: Session, org_id: uuid.UUID, kind: str, amount: int, key: str, *, reservation_id: uuid.UUID | None = None,
           actor_id: uuid.UUID | None = None, note: str = "", model: str | None = None, tin: int | None = None, tout: int | None = None) -> LedgerEntry:
    e = LedgerEntry(organization_id=org_id, kind=kind, amount=amount, idempotency_key=key, reservation_id=reservation_id,
                    actor_user_id=actor_id, note=note[:240], model=model, tokens_in=tin, tokens_out=tout)
    db.add(e)
    db.flush()
    return e


def get_balance(db: Session, org_id: uuid.UUID) -> Balance:
    w = db.scalar(select(Wallet).where(Wallet.organization_id == org_id).execution_options(populate_existing=True))
    return Balance(w.balance, w.held) if w else Balance(0, 0)


def issue(db: Session, org_id: uuid.UUID, amount: int, *, key: str, actor_id: uuid.UUID | None, note: str) -> tuple[LedgerEntry, bool]:
    """Начисление (тестовые кредиты администратором). Возвращает (проводка, создана_ли_сейчас)."""
    _check_amount(amount)
    _check_key(key)
    if not note.strip():
        raise LedgerError("note_required", "Укажите причину начисления.", 422)
    w = _lock_wallet(db, org_id)
    ex = _existing(db, org_id, key)
    if ex is not None:
        _same(ex, "credit", amount)
        return ex, False
    e = _entry(db, org_id, "credit", amount, key, actor_id=actor_id, note=note)
    w.balance += amount
    db.flush()
    return e, True


def adjust(db: Session, org_id: uuid.UUID, amount: int, *, key: str, actor_id: uuid.UUID, note: str) -> tuple[LedgerEntry, bool]:
    """Ручная корректировка со знаком. Обязательны причина и автор; уход доступного остатка в минус запрещён."""
    _check_amount(amount, signed=True)
    _check_key(key)
    if not note.strip():
        raise LedgerError("note_required", "Корректировка без причины запрещена.", 422)
    w = _lock_wallet(db, org_id)
    ex = _existing(db, org_id, key)
    if ex is not None:
        _same(ex, "adjustment", amount)
        return ex, False
    if w.balance - w.held + amount < 0:
        raise LedgerError("insufficient_credits", "Корректировка увела бы доступный остаток в минус.", 402)
    e = _entry(db, org_id, "adjustment", amount, key, actor_id=actor_id, note=note)
    w.balance += amount
    db.flush()
    return e, True


def reserve(db: Session, org_id: uuid.UUID, amount: int, *, key: str, actor_id: uuid.UUID | None = None, note: str = "") -> tuple[Reservation, bool]:
    _check_amount(amount)
    _check_key(key)
    w = _lock_wallet(db, org_id)
    ex = _existing(db, org_id, key)
    if ex is not None:
        _same(ex, "reserve", amount)
        res = db.get(Reservation, ex.reservation_id, populate_existing=True) if ex.reservation_id else None
        if res is None:
            raise LedgerError("integrity", "Резерв для проводки не найден.", 500)
        return res, False
    if w.balance - w.held < amount:
        raise LedgerError("insufficient_credits", "Недостаточно кредитов.", 402)
    res = Reservation(organization_id=org_id, amount=amount, status="open")
    db.add(res)
    db.flush()
    _entry(db, org_id, "reserve", amount, key, reservation_id=res.id, actor_id=actor_id, note=note)
    w.held += amount
    db.flush()
    return res, True


def _lock_reservation(db: Session, reservation_id: uuid.UUID) -> tuple[Wallet, Reservation]:
    org_id = db.scalar(select(Reservation.organization_id).where(Reservation.id == reservation_id))
    if org_id is None:
        raise LedgerError("not_found", "Резерв не найден.", 404)
    w = _lock_wallet(db, org_id)  # порядок блокировок всегда «кошелёк → резерв»: без взаимных блокировок
    res = db.scalar(select(Reservation).where(Reservation.id == reservation_id).with_for_update().execution_options(populate_existing=True))
    assert res is not None
    return w, res


def capture(db: Session, reservation_id: uuid.UUID, actual: int, *, key: str, model: str | None = None, tokens_in: int | None = None,
            tokens_out: int | None = None, note: str = "") -> LedgerEntry | None:
    """Списание по факту. Списывается не больше резерва (перерасход не списывается и не уводит баланс в минус); остаток резерва
    возвращается проводкой release. actual == 0 равносильно освобождению."""
    if isinstance(actual, bool) or not isinstance(actual, int) or actual < 0:
        raise LedgerError("bad_amount", "Фактическая сумма — целое неотрицательное число.", 422)
    _check_key(key)
    w, res = _lock_reservation(db, reservation_id)
    ex = _existing(db, res.organization_id, key)
    if ex is not None:
        if ex.kind != "capture" or ex.reservation_id != res.id:
            raise LedgerError("idempotency_conflict", "Этот ключ идемпотентности уже использован для другой операции.")
        return ex
    if res.status != "open":
        raise LedgerError("reservation_settled", "Резерв уже закрыт.")
    charge = min(actual, res.amount)
    over = actual - charge
    now = utcnow()
    first: LedgerEntry | None = None
    if charge > 0:
        extra = f" Перерасход {over} не списан." if over else ""
        first = _entry(db, res.organization_id, "capture", charge, key, reservation_id=res.id, note=(note + extra).strip(),
                       model=model, tin=tokens_in, tout=tokens_out)
    rest = res.amount - charge
    if rest > 0:
        _entry(db, res.organization_id, "release", rest, f"{key}:rel", reservation_id=res.id, note="Остаток резерва")
    w.balance -= charge
    w.held -= res.amount
    res.status = "captured" if charge > 0 else "released"
    res.captured = charge
    res.settled_at = now
    db.flush()
    return first


def release(db: Session, reservation_id: uuid.UUID, *, key: str, note: str = "") -> LedgerEntry | None:
    """Полное освобождение резерва (ошибка провайдера, отмена). Повтор и вызов по уже закрытому резерву — без эффекта."""
    _check_key(key)
    w, res = _lock_reservation(db, reservation_id)
    ex = _existing(db, res.organization_id, key)
    if ex is not None:
        if ex.kind != "release" or ex.reservation_id != res.id:
            raise LedgerError("idempotency_conflict", "Этот ключ идемпотентности уже использован для другой операции.")
        return ex
    if res.status != "open":
        return None
    e = _entry(db, res.organization_id, "release", res.amount, key, reservation_id=res.id, note=note or "Резерв освобождён")
    w.held -= res.amount
    res.status = "released"
    res.settled_at = utcnow()
    db.flush()
    return e


def release_stale(db: Session, older_than: dt.timedelta) -> int:
    """Освобождает резервы, «повисшие» из-за падения процесса между резервом и списанием. Возвращает число освобождённых."""
    cutoff = utcnow() - older_than
    ids = list(db.scalars(select(Reservation.id).where(Reservation.status == "open", Reservation.created_at < cutoff)).all())
    n = 0
    for rid in ids:
        if release(db, rid, key=f"stale:{rid}", note="Освобождено автоматически: списание не состоялось") is not None:
            n += 1
    if n:
        db.commit()
    return n


def spent_since(db: Session, org_id: uuid.UUID, since: dt.datetime) -> int:
    return int(db.scalar(select(func.coalesce(func.sum(LedgerEntry.amount), 0)).where(
        LedgerEntry.organization_id == org_id, LedgerEntry.kind == "capture", LedgerEntry.created_at >= since)) or 0)


def verify(db: Session, org_id: uuid.UUID) -> list[str]:
    """Сверка кэша кошелька с проводками. Пустой список = всё сходится."""
    def total(kind: str) -> int:
        return int(db.scalar(select(func.coalesce(func.sum(LedgerEntry.amount), 0)).where(
            LedgerEntry.organization_id == org_id, LedgerEntry.kind == kind)) or 0)

    problems: list[str] = []
    b = get_balance(db, org_id)
    expected = total("credit") + total("adjustment") - total("capture")
    if b.balance != expected:
        problems.append(f"balance {b.balance} != сумма проводок {expected}")
    open_sum = int(db.scalar(select(func.coalesce(func.sum(Reservation.amount), 0)).where(
        Reservation.organization_id == org_id, Reservation.status == "open")) or 0)
    if b.held != open_sum:
        problems.append(f"held {b.held} != открытые резервы {open_sum}")
    if total("reserve") != total("capture") + total("release") + open_sum:
        problems.append("резервы не сходятся: reserve != capture + release + открытые")
    if b.available < 0:
        problems.append("доступный остаток отрицателен")
    return problems
