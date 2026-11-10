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
os.environ["WORKER_ENABLED"] = "false"  # воркер в тестах вызывается явно

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
            "memberships, users, organizations, ai_keys, conversations, messages, action_plans, approvals, ai_usage, jobs, job_steps, wallets, ledger_reservations, ledger_entries, platform_models "
            "RESTART IDENTITY CASCADE"))
    from app.modules.ai import service as ai_service  # noqa: PLC0415
    ai_service.reset_limiter()
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


# ───────────────────────── Фаза 3: помощники для AI и планов ─────────────────────────
import datetime as _dt  # noqa: E402
from typing import Any  # noqa: E402

from app.db.models import Server, ServerMetricSample  # noqa: E402
from app.modules.ai import providers as _providers  # noqa: E402
from app.modules.ai.providers import ProviderError, ToolCall, Turn  # noqa: E402


def make_server(db: Session, org_id: uuid.UUID, *, name: str = "web-1", status: str = "online", disk_used: float = 12.0,
                services: list[tuple[str, str]] | None = None, with_sample: bool = True, os_name: str = "Ubuntu 24.04.1 LTS") -> Server:
    """Сервер с сохранённым измерением (без SSH): для тестов AI/политики, которые читают только сохранённые данные."""
    now = _dt.datetime.now(_dt.UTC)
    srv = Server(organization_id=org_id, name=name, host=f"{name}.example.com", port=22, username="servermind", os=os_name,
                 host_key_openssh="ssh-ed25519 AAAA", fingerprint="SHA256:" + "A" * 43, status=status,
                 last_checked_at=now, last_success_at=now)
    db.add(srv)
    db.flush()
    if with_sample:
        db.add(ServerMetricSample(
            organization_id=org_id, server_id=srv.id, sampled_at=now, os=os_name, uptime_seconds=86400, cpu_percent=50.0, ram_used_mb=2048,
            ram_total_mb=4096, disk_used_gb=disk_used, disk_total_gb=40.0,
            services=[{"name": n, "state": s} for n, s in (services if services is not None else [("ssh", "active"), ("nginx", "failed"), ("docker", "active")])]))
    db.commit()
    return srv


class FakeProvider:
    """Сценарий ответов «модели». Записывает всё, что УШЛО бы провайдеру (для проверок утечек и prompt injection)."""

    def __init__(self) -> None:
        self.script: list[Turn | ProviderError] = []
        self.calls: list[dict[str, Any]] = []
        self.validate_result = "valid"

    def chat(self, **kw: Any) -> Turn:
        self.calls.append({**kw, "messages": [dict(m) for m in kw["messages"]]})
        if not self.script:
            return Turn(text="(нет сценария)")
        r = self.script.pop(0)
        if isinstance(r, ProviderError):
            raise r
        return r

    def validate_key(self, api_key: str, timeout: float) -> str:
        return self.validate_result


def tool_turn(*calls: tuple[str, dict[str, Any] | None], text: str = "") -> Turn:
    return Turn(text=text, tool_calls=[ToolCall(id=f"call_{i}", name=n, arguments=a) for i, (n, a) in enumerate(calls)], input_tokens=100, output_tokens=20)


def text_turn(text: str) -> Turn:
    return Turn(text=text, input_tokens=100, output_tokens=20)


@pytest.fixture
def fake_provider(monkeypatch: pytest.MonkeyPatch) -> FakeProvider:
    fp = FakeProvider()
    for name in ("openai", "anthropic", "deepseek"):
        monkeypatch.setitem(_providers.PROVIDERS, name, fp)
    return fp


KEY = "sk-TESTKEY-0123456789abcdefghij"


def add_ai_key(client: TestClient, h: dict[str, str], provider: str = "openai", model: str = "test-model") -> dict[str, Any]:
    r = client.post("/api/v1/ai-keys", headers=h, json={"provider": provider, "key": KEY, "model": model, "skipValidation": True})
    assert r.status_code == 201, r.text
    return r.json()
