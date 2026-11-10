from __future__ import annotations

import base64
import os
import pathlib
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass

# Окружение должно быть задано ДО импорта приложения
os.environ.setdefault("ENCRYPTION_MASTER_KEY", base64.b64encode(os.urandom(32)).decode())
os.environ["DATABASE_URL"] = os.environ.get(
    "TEST_DATABASE_URL", "postgresql+psycopg://servermind:servermind_test_only@127.0.0.1:5432/servermind_test")
os.environ["COOKIE_SECURE"] = "false"
os.environ["ALLOW_PRIVATE_TARGETS"] = "true"  # только для тестов: цель — локальный fake sshd
os.environ["ENVIRONMENT"] = "test"

import pyotp  # noqa: E402
import pytest  # noqa: E402
from alembic.config import Config  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from alembic import command  # noqa: E402
from app.core.config import get_settings  # noqa: E402
from app.core.security import encrypt, hash_password, new_totp_secret  # noqa: E402
from app.db.models import Membership, Organization, User  # noqa: E402
from app.db.session import _factory, get_engine, reset_engine  # noqa: E402
from app.main import create_app  # noqa: E402
from app.modules.servers import router as servers_router  # noqa: E402
from tests.fake_sshd import FakeSshd  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
PASSWORD = "correct-horse-battery-staple"


@pytest.fixture(scope="session", autouse=True)
def _schema() -> Iterator[None]:
    reset_engine()
    with get_engine().begin() as c:
        c.execute(text("DROP SCHEMA public CASCADE"))
        c.execute(text("CREATE SCHEMA public"))
    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "alembic"))
    command.upgrade(cfg, "head")  # тесты идут на РЕАЛЬНОЙ миграции, а не на create_all
    yield


@pytest.fixture(autouse=True)
def _clean(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    get_settings.cache_clear()
    servers_router.reset_limiter()
    with get_engine().begin() as c:
        c.execute(text(
            "TRUNCATE audit_events, login_attempts, server_metric_samples, server_credentials, servers, sessions, "
            "memberships, users, organizations RESTART IDENTITY CASCADE"))
    yield
    get_settings.cache_clear()


def set_env(monkeypatch: pytest.MonkeyPatch, **values: str) -> None:
    for k, v in values.items():
        monkeypatch.setenv(k.upper(), v)
    get_settings.cache_clear()


@pytest.fixture
def db() -> Iterator[Session]:
    with _factory()() as s:
        yield s


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(create_app(), base_url="http://testserver") as c:
        yield c


@dataclass
class U:
    id: uuid.UUID
    org_id: uuid.UUID
    email: str
    role: str
    totp_secret: str | None


def make_user(db: Session, email: str, *, role: str = "owner", org_id: uuid.UUID | None = None, totp: bool = True,
              password: str = PASSWORD) -> U:
    if org_id is None:
        org = Organization(name=f"Org {email}")
        db.add(org)
        db.flush()
        org_id = org.id
    secret = new_totp_secret() if totp else None
    user = User(email=email.lower(), name=email.split("@")[0], password_hash=hash_password(password), totp_enabled=totp)
    db.add(user)
    db.flush()
    if secret:
        user.totp_secret_enc = encrypt(get_settings().master_key_bytes, secret.encode(), f"totp:{user.id}".encode())
    db.add(Membership(organization_id=org_id, user_id=user.id, role=role))
    db.commit()
    return U(user.id, org_id, user.email, role, secret)


def login_full(client: TestClient, db: Session, u: U, *, password: str = PASSWORD) -> dict[str, str]:
    """Полный вход с 2FA. Возвращает заголовки с CSRF. last_step сбрасывается (тестовый шорткат: код TOTP одноразовый)."""
    assert u.totp_secret
    db.execute(text("UPDATE users SET totp_last_step = 0 WHERE id = :i"), {"i": u.id})
    db.commit()
    client.cookies.clear()
    r = client.post("/api/v1/auth/login", json={"email": u.email, "password": password})
    assert r.status_code == 200, r.text
    csrf = r.json()["csrfToken"]
    r = client.post("/api/v1/auth/2fa", json={"code": pyotp.TOTP(u.totp_secret).now()}, headers={"X-CSRF-Token": csrf})
    assert r.status_code == 200, r.text
    return {"X-CSRF-Token": r.json()["csrfToken"]}


@pytest.fixture
def owner(db: Session) -> U:
    return make_user(db, "owner@example.com", role="owner")


@pytest.fixture
def sshd() -> Iterator[FakeSshd]:
    s = FakeSshd().start()
    yield s
    s.stop()


def now_ts() -> float:
    return time.time()
