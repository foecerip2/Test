"""Кредитный ledger: инварианты (ADR 0005). Реальная PostgreSQL, в том числе гонки из нескольких потоков."""

from __future__ import annotations

import datetime as dt
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.db.session import _factory
from app.modules.billing import ledger
from app.modules.billing.ledger import LedgerError
from tests.conftest import make_user

K = "key-0123456789"


@pytest.fixture
def org(db, owner):
    return owner.org_id


def k(n: str) -> str:
    return f"{n}-{uuid.uuid4().hex[:10]}"


def fund(db, org, amount=100):
    ledger.issue(db, org, amount, key=k("issue"), actor_id=None, note="тест")
    db.commit()


def ok(db, org):
    assert ledger.verify(db, org) == []


def test_issue_is_idempotent_and_conflicting_key_is_refused(db, org, owner):
    e1, c1 = ledger.issue(db, org, 100, key=K, actor_id=owner.id, note="beta")
    db.commit()
    e2, c2 = ledger.issue(db, org, 100, key=K, actor_id=owner.id, note="beta")
    db.commit()
    assert c1 is True and c2 is False and e1.id == e2.id
    assert ledger.get_balance(db, org).available == 100  # повтор не начислил второй раз
    with pytest.raises(LedgerError) as ei:
        ledger.issue(db, org, 200, key=K, actor_id=owner.id, note="beta")
    assert ei.value.code == "idempotency_conflict"
    db.rollback()
    ok(db, org)


@pytest.mark.parametrize("bad", [0, -5, True, 1.5, 10**13, "10"])
def test_bad_amounts_are_refused(db, org, bad):
    with pytest.raises(LedgerError) as ei:
        ledger.issue(db, org, bad, key=k("bad"), actor_id=None, note="x")  # type: ignore[arg-type]
    assert ei.value.code == "bad_amount"
    db.rollback()
    assert ledger.get_balance(db, org).balance == 0


def test_issue_requires_reason_and_valid_key(db, org):
    with pytest.raises(LedgerError) as e1:
        ledger.issue(db, org, 10, key=k("x"), actor_id=None, note="  ")
    assert e1.value.code == "note_required"
    with pytest.raises(LedgerError) as e2:
        ledger.issue(db, org, 10, key="short", actor_id=None, note="n")
    assert e2.value.code == "bad_idempotency_key"
    db.rollback()


def test_reserve_cannot_exceed_available_and_changes_nothing(db, org):
    fund(db, org, 100)
    ledger.reserve(db, org, 70, key=k("r"))
    db.commit()
    with pytest.raises(LedgerError) as ei:
        ledger.reserve(db, org, 40, key=k("r2"))  # доступно 30
    assert ei.value.code == "insufficient_credits" and ei.value.status == 402
    db.rollback()
    b = ledger.get_balance(db, org)
    assert (b.balance, b.held, b.available) == (100, 70, 30)
    ok(db, org)


def test_capture_less_than_reserved_returns_the_rest(db, org):
    fund(db, org, 100)
    res, _ = ledger.reserve(db, org, 60, key=k("r"))
    e = ledger.capture(db, res.id, 25, key=k("c"), model="m", tokens_in=1000, tokens_out=200)
    db.commit()
    b = ledger.get_balance(db, org)
    assert (b.balance, b.held, b.available) == (75, 0, 75) and e.amount == 25 and e.tokens_in == 1000
    kinds = [r[0] for r in db.execute(text("SELECT kind FROM ledger_entries ORDER BY created_at, id")).all()]
    assert sorted(kinds) == ["capture", "credit", "release", "reserve"]
    ok(db, org)


def test_capture_more_than_reserved_is_capped_and_never_negative(db, org):
    fund(db, org, 50)
    res, _ = ledger.reserve(db, org, 50, key=k("r"))
    e = ledger.capture(db, res.id, 80, key=k("c"))
    db.commit()
    b = ledger.get_balance(db, org)
    assert e.amount == 50 and "Перерасход 30 не списан" in e.note
    assert (b.balance, b.held) == (0, 0)
    ok(db, org)


def test_capture_is_idempotent_and_reservation_settles_exactly_once(db, org):
    fund(db, org, 100)
    res, _ = ledger.reserve(db, org, 40, key=k("r"))
    ck = k("c")
    e1 = ledger.capture(db, res.id, 30, key=ck)
    e2 = ledger.capture(db, res.id, 30, key=ck)  # повтор с тем же ключом (ретрай после сетевой ошибки)
    db.commit()
    assert e1 is not None and e2 is not None and e1.id == e2.id
    assert ledger.get_balance(db, org).balance == 70  # списано один раз
    with pytest.raises(LedgerError) as ei:
        ledger.capture(db, res.id, 30, key=k("c2"))  # другой ключ — это уже второе списание того же резерва
    assert ei.value.code == "reservation_settled"
    db.rollback()
    assert ledger.release(db, res.id, key=k("rel")) is None  # освободить закрытый резерв нельзя
    db.commit()
    assert ledger.get_balance(db, org).balance == 70
    ok(db, org)


def test_capture_zero_acts_as_release(db, org):
    fund(db, org, 100)
    res, _ = ledger.reserve(db, org, 40, key=k("r"))
    assert ledger.capture(db, res.id, 0, key=k("c")) is None
    db.commit()
    b = ledger.get_balance(db, org)
    assert (b.balance, b.held) == (100, 0)
    ok(db, org)


def test_release_is_idempotent_and_frees_the_hold(db, org):
    fund(db, org, 100)
    res, _ = ledger.reserve(db, org, 40, key=k("r"))
    rk = k("rel")
    a, b = ledger.release(db, res.id, key=rk), ledger.release(db, res.id, key=rk)
    db.commit()
    assert a is not None and b is not None and a.id == b.id
    assert ledger.get_balance(db, org).held == 0
    ok(db, org)


def test_reserve_replay_returns_same_reservation_and_holds_once(db, org):
    fund(db, org, 100)
    rk = k("r")
    r1, c1 = ledger.reserve(db, org, 40, key=rk)
    r2, c2 = ledger.reserve(db, org, 40, key=rk)
    db.commit()
    assert r1.id == r2.id and c1 and not c2 and ledger.get_balance(db, org).held == 40
    with pytest.raises(LedgerError):
        ledger.reserve(db, org, 41, key=rk)  # тот же ключ, другая сумма
    db.rollback()


def test_adjustment_needs_note_and_cannot_go_below_zero(db, org, owner):
    fund(db, org, 100)
    ledger.reserve(db, org, 80, key=k("r"))
    db.commit()
    with pytest.raises(LedgerError) as e1:
        ledger.adjust(db, org, -30, key=k("a"), actor_id=owner.id, note="списать")  # доступно только 20
    assert e1.value.code == "insufficient_credits"
    db.rollback()
    with pytest.raises(LedgerError) as e2:
        ledger.adjust(db, org, 10, key=k("a"), actor_id=owner.id, note="")
    assert e2.value.code == "note_required"
    db.rollback()
    ledger.adjust(db, org, -20, key=k("a"), actor_id=owner.id, note="возврат оператору")
    ledger.adjust(db, org, 5, key=k("a"), actor_id=owner.id, note="компенсация")
    db.commit()
    assert ledger.get_balance(db, org).balance == 85
    ok(db, org)


def test_db_itself_refuses_negative_balance_and_rewriting_the_journal(db, org):
    fund(db, org, 100)
    ledger.reserve(db, org, 50, key=k("r"))
    db.commit()
    for sql in ("UPDATE wallets SET balance = -1", "UPDATE wallets SET held = 101", "UPDATE wallets SET balance = 40"):  # 40 < held 50
        with pytest.raises(IntegrityError):
            db.execute(text(sql))
            db.commit()
        db.rollback()
    with pytest.raises(DBAPIError):
        db.execute(text("UPDATE ledger_entries SET amount = 1000000 WHERE kind = 'credit'"))
        db.commit()
    db.rollback()
    with pytest.raises(IntegrityError):  # знак: списывающие проводки обязаны быть положительными
        db.execute(text("INSERT INTO ledger_entries (id, organization_id, kind, amount, idempotency_key, note) "
                        "VALUES (gen_random_uuid(), :o, 'capture', -5, 'neg-0123456789', '')"), {"o": org})
        db.commit()
    db.rollback()


def test_verify_detects_a_tampered_wallet(db, org):
    fund(db, org, 100)
    db.execute(text("UPDATE wallets SET balance = 150"))  # CHECK не нарушен, но проводкам не соответствует
    db.commit()
    problems = ledger.verify(db, org)
    assert problems and "balance 150" in problems[0]


def test_stale_reservations_are_released_but_fresh_ones_are_kept(db, org):
    fund(db, org, 100)
    old, _ = ledger.reserve(db, org, 30, key=k("old"))
    ledger.reserve(db, org, 20, key=k("fresh"))
    db.commit()
    db.execute(text("UPDATE ledger_reservations SET created_at = :t WHERE id = :i"), {"t": dt.datetime.now(dt.UTC) - dt.timedelta(minutes=30), "i": old.id})
    db.commit()
    assert ledger.release_stale(db, dt.timedelta(minutes=10)) == 1
    assert ledger.release_stale(db, dt.timedelta(minutes=10)) == 0  # повторный запуск ничего не делает
    b = ledger.get_balance(db, org)
    assert (b.balance, b.held) == (100, 20)
    ok(db, org)


def test_spent_since_counts_only_captures(db, org):
    fund(db, org, 100)
    res, _ = ledger.reserve(db, org, 40, key=k("r"))
    ledger.capture(db, res.id, 15, key=k("c"))
    db.commit()
    day_ago = dt.datetime.now(dt.UTC) - dt.timedelta(days=1)
    assert ledger.spent_since(db, org, day_ago) == 15
    assert ledger.spent_since(db, org, dt.datetime.now(dt.UTC) + dt.timedelta(minutes=1)) == 0


def test_concurrent_reserves_never_overspend(db, org):
    fund(db, org, 100)

    def attempt(i: int) -> str:
        with _factory()() as s:
            try:
                ledger.reserve(s, org, 30, key=f"race-{i:04d}-abcdef")
                s.commit()
                return "ok"
            except LedgerError as e:
                s.rollback()
                return e.code

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(attempt, range(8)))
    assert results.count("ok") == 3 and results.count("insufficient_credits") == 5  # 3 × 30 = 90 ≤ 100
    b = ledger.get_balance(db, org)
    assert (b.balance, b.held, b.available) == (100, 90, 10)
    ok(db, org)


def test_concurrent_identical_requests_apply_once(db, org):
    fund(db, org, 100)

    def attempt(_: int) -> bool:
        with _factory()() as s:
            _, created = ledger.reserve(s, org, 30, key="same-key-0123456789")
            s.commit()
            return created

    with ThreadPoolExecutor(max_workers=8) as pool:
        created = list(pool.map(attempt, range(8)))
    assert created.count(True) == 1
    assert ledger.get_balance(db, org).held == 30
    assert db.execute(text("SELECT count(*) FROM ledger_entries WHERE kind='reserve'")).scalar() == 1
    ok(db, org)


def test_concurrent_capture_and_release_of_one_reservation_settle_once(db, org):
    fund(db, org, 100)
    res, _ = ledger.reserve(db, org, 40, key=k("r"))
    db.commit()

    def settle(i: int) -> str:
        with _factory()() as s:
            try:
                if i % 2:
                    ledger.capture(s, res.id, 25, key=f"cap-{i:04d}-abcdefgh")
                else:
                    ledger.release(s, res.id, key=f"rel-{i:04d}-abcdefgh")
                s.commit()
                return "done"
            except LedgerError as e:
                s.rollback()
                return e.code

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(settle, range(8)))
    b = ledger.get_balance(db, org)
    assert b.held == 0 and b.balance in (100, 75)  # либо освобождён целиком, либо списано ровно один раз
    ok(db, org)


def test_organizations_have_separate_wallets(db, org):
    other = make_user(db, "other@example.com").org_id
    fund(db, org, 100)
    assert ledger.get_balance(db, other).available == 0
    with pytest.raises(LedgerError):
        ledger.reserve(db, other, 1, key=k("r"))
    db.rollback()
    ok(db, org)
    ok(db, other)
