"""Alembic: upgrade/downgrade 0002 на SQLite и совпадение схемы с моделями."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy.exc import IntegrityError

from app import models
from app.db import Base

API_DIR = Path(__file__).resolve().parent.parent
NEW_TABLES = {"companies", "company_facts", "lead_scores", "import_jobs", "activity_events"}
OLD_TABLES = {"users", "otp_challenges", "sessions", "audit_logs", "rate_limits"}


def _config(url: str) -> Config:
    cfg = Config()
    cfg.set_main_option("script_location", str(API_DIR / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)
    return cfg


@pytest.fixture
def db_url(tmp_path: Path) -> str:
    return f"sqlite+pysqlite:///{tmp_path}/migrate.db"


def _tables(url: str) -> set[str]:
    engine = sa.create_engine(url)
    try:
        return set(sa.inspect(engine).get_table_names()) - {"alembic_version"}
    finally:
        engine.dispose()


def _version(url: str) -> str | None:
    engine = sa.create_engine(url)
    try:
        with engine.connect() as c:
            return c.execute(sa.text("SELECT version_num FROM alembic_version")).scalar()
    finally:
        engine.dispose()


def test_upgrade_creates_all_tables(db_url: str) -> None:
    command.upgrade(_config(db_url), "head")
    assert _tables(db_url) == OLD_TABLES | NEW_TABLES
    assert _version(db_url) == "0002"


def test_downgrade_to_0001_removes_only_new_tables(db_url: str) -> None:
    cfg = _config(db_url)
    command.upgrade(cfg, "head")
    command.downgrade(cfg, "0001")
    assert _tables(db_url) == OLD_TABLES
    assert _version(db_url) == "0001"
    command.downgrade(cfg, "base")
    assert _tables(db_url) == set()


def test_upgrade_downgrade_upgrade_roundtrip(db_url: str) -> None:
    cfg = _config(db_url)
    command.upgrade(cfg, "head")
    command.downgrade(cfg, "0001")
    command.upgrade(cfg, "head")
    assert _tables(db_url) == OLD_TABLES | NEW_TABLES


def test_schema_matches_models(db_url: str) -> None:
    """Автогенерация не находит расхождений между миграциями и моделями."""
    command.upgrade(_config(db_url), "head")
    engine = sa.create_engine(db_url)
    try:
        with engine.connect() as conn:
            ctx = MigrationContext.configure(conn, opts={"compare_type": False})
            diff = compare_metadata(ctx, Base.metadata)
    finally:
        engine.dispose()
    assert diff == []


def test_migrated_schema_enforces_constraints(db_url: str) -> None:
    command.upgrade(_config(db_url), "head")
    engine = sa.create_engine(db_url)
    now = datetime(2026, 11, 10, tzinfo=UTC)

    def company(inn: str | None) -> dict[str, Any]:
        return {
            "id": uuid.uuid4().hex,
            "name": "Север",
            "normalized_name": "север",
            "inn": inn,
            "city": "Казань",
            "city_norm": "казань",
            "category": "Автосервис",
            "source_label": "Тест",
            "created_at": now.isoformat(),
            "updated_at": now.isoformat(),
        }

    insert = sa.text(
        "INSERT INTO companies (id, name, normalized_name, inn, city, city_norm, category,"
        " source_label, created_at, updated_at) VALUES (:id, :name, :normalized_name, :inn,"
        " :city, :city_norm, :category, :source_label, :created_at, :updated_at)"
    )
    try:
        with engine.begin() as conn:
            for inn in (None, None, "7707083893"):
                conn.execute(insert, company(inn))
        with pytest.raises(IntegrityError), engine.begin() as conn:
            conn.execute(insert, company("7707083893"))
        with engine.connect() as conn:
            row = conn.execute(sa.text("SELECT state, stage, score, demo FROM companies")).first()
        assert tuple(row or ()) == ("discovered", "new", 0, 0)
    finally:
        engine.dispose()


def test_partial_unique_index_declared_for_both_dialects() -> None:
    idx = next(i for i in models.Company.__table__.indexes if i.name == "uq_companies_inn")
    assert idx.unique is True
    assert "IS NOT NULL" in str(idx.dialect_options["postgresql"]["where"])
    assert "IS NOT NULL" in str(idx.dialect_options["sqlite"]["where"])


def test_offline_sql_for_postgresql_renders(capsys: pytest.CaptureFixture[str]) -> None:
    """Офлайн-генерация SQL для PostgreSQL (без сервера): JSONB, partial index, timestamptz."""
    cfg = _config("postgresql+psycopg://u:p@localhost/db")
    command.upgrade(cfg, "0001:0002", sql=True)
    out = capsys.readouterr().out
    assert "CREATE UNIQUE INDEX uq_companies_inn ON companies (inn) WHERE inn IS NOT NULL" in out
    assert "reasons JSONB NOT NULL" in out and "payload_redacted JSONB" in out
    assert "UUID" in out and "TIMESTAMP WITH TIME ZONE" in out
    assert "CONSTRAINT ck_companies_stage CHECK" in out
