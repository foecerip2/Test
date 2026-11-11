"""Здоровье, миграции, мелочи."""

from __future__ import annotations

from pathlib import Path

import sqlalchemy as sa
from alembic import command
from alembic.config import Config

from app.security import mask_email
from tests.conftest import Ctx


def test_healthz_and_readyz(ctx: Ctx) -> None:
    assert ctx.client.get("/healthz").json() == {"status": "ok"}
    assert ctx.client.get("/readyz").json() == {"status": "ok"}


def test_readyz_fails_when_db_down(ctx: Ctx) -> None:
    ctx.app.state.engine.dispose()
    ctx.app.state.session_factory.configure(
        bind=sa.create_engine("sqlite:////nonexistent-dir/x.db")
    )
    r = ctx.client.get("/readyz")
    assert r.status_code == 503 and r.json()["code"] == "NOT_READY"


def test_unknown_route_uses_error_format(ctx: Ctx) -> None:
    r = ctx.client.get("/api/v1/nope")
    assert r.status_code == 404 and r.json()["code"] == "NOT_FOUND" and r.json()["request_id"]


def test_mask_email() -> None:
    assert mask_email("alice@example.ru") == "a***@e***.ru"
    assert mask_email("bad") == "***"


def test_alembic_upgrade_head_creates_schema(tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    db = tmp_path / "mig.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite+pysqlite:///{db}")
    api_dir = Path(__file__).resolve().parent.parent
    cfg = Config(str(api_dir / "alembic.ini"))
    cfg.set_main_option("script_location", str(api_dir / "alembic"))
    command.upgrade(cfg, "head")
    insp = sa.inspect(sa.create_engine(f"sqlite+pysqlite:///{db}"))
    assert {"users", "otp_challenges", "sessions", "audit_logs", "rate_limits"} <= set(
        insp.get_table_names()
    )
    cols = {c["name"] for c in insp.get_columns("otp_challenges")}
    assert {
        "code_hmac",
        "expires_at",
        "attempts",
        "sends",
        "last_sent_at",
        "consumed_at",
        "ip_hash",
    } <= cols
    command.downgrade(cfg, "base")
