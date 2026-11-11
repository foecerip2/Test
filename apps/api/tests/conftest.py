"""Общие фикстуры: приложение на SQLite, подставная почта, управляемое время."""

from __future__ import annotations

import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import security
from app.config import Settings
from app.db import Base
from app.mail import MailError
from app.main import create_app
from app.models import User

ENV_VARS = [
    "ENV",
    "DATABASE_URL",
    "SECRET_KEY",
    "PUBLIC_ORIGIN",
    "COOKIE_SECURE",
    "OWNER_EMAIL",
    "MAIL_BACKEND",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "SMTP_FROM",
    "SMTP_SECURITY",
    "TRUST_PROXY_HEADERS",
]

OWNER = "owner@example.com"
ORIGIN = "http://localhost:3000"


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ENV_VARS:
        monkeypatch.delenv(name, raising=False)


class FakeMailer:
    def __init__(self) -> None:
        self.sent: list[dict[str, str]] = []
        self.fail = False

    def send(self, to: str, subject: str, text: str, html_body: str) -> None:
        if self.fail:
            raise MailError("SMTPException")
        self.sent.append({"to": to, "subject": subject, "text": text, "html": html_body})

    @property
    def code(self) -> str:
        m = re.search(r": (\d{6})$", self.sent[-1]["subject"])
        assert m
        return m.group(1)


class Clock:
    def __init__(self) -> None:
        self.t = datetime(2026, 11, 10, 12, 0, 0, tzinfo=UTC)

    def now(self) -> datetime:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += timedelta(seconds=seconds)


@dataclass
class Ctx:
    client: TestClient
    mailer: FakeMailer
    settings: Settings
    clock: Clock
    app: Any
    _n: int = field(default=0)

    def db(self) -> Session:
        return self.app.state.session_factory()

    def request_code(self, email: str, ip: str | None = None) -> Any:
        headers = {"X-Forwarded-For": ip} if ip else {}
        return self.client.post("/api/v1/auth/otp/request", json={"email": email}, headers=headers)

    def verify(self, challenge_id: str, code: str) -> Any:
        return self.client.post(
            "/api/v1/auth/otp/verify", json={"challenge_id": challenge_id, "code": code}
        )

    def login(self, email: str, client: TestClient | None = None) -> Any:
        """Полный вход; возвращает ответ verify. Время сдвигается, чтобы обойти cooldown."""
        c = client or self.client
        self.clock.advance(120)
        r = c.post("/api/v1/auth/otp/request", json={"email": email})
        assert r.status_code == 202, r.text
        v = c.post(
            "/api/v1/auth/otp/verify",
            json={"challenge_id": r.json()["challenge_id"], "code": self.mailer.code},
        )
        assert v.status_code == 200, v.text
        return v

    def new_client(self) -> TestClient:
        return TestClient(self.app, base_url=ORIGIN)

    def csrf(self, client: TestClient | None = None) -> dict[str, str]:
        c = client or self.client
        return {"X-CSRF-Token": c.cookies.get("lh_csrf") or ""}

    def user(self, email: str) -> User:
        with self.db() as db:
            u = db.scalar(select(User).where(User.email == email))
            assert u is not None
            return u


@pytest.fixture
def make_ctx(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Callable[..., Ctx]]:
    clients: list[TestClient] = []

    def factory(**overrides: Any) -> Ctx:
        values: dict[str, Any] = {
            "env": "dev",
            "database_url": f"sqlite+pysqlite:///{tmp_path}/test-{len(clients)}.db",
            "secret_key": "test-secret-key-0123456789-0123456789",
            "public_origin": ORIGIN,
            "owner_email": OWNER,
            "mail_backend": "console",
            "trust_proxy_headers": True,
        }
        values.update(overrides)
        settings = Settings(**values)
        mailer = FakeMailer()
        app = create_app(settings, mailer)
        Base.metadata.create_all(app.state.engine)
        clock = Clock()
        monkeypatch.setattr(security, "now", clock.now)
        client = TestClient(app, base_url=ORIGIN)
        clients.append(client)
        return Ctx(client=client, mailer=mailer, settings=settings, clock=clock, app=app)

    yield factory
    for c in clients:
        c.close()


@pytest.fixture
def ctx(make_ctx: Callable[..., Ctx]) -> Ctx:
    return make_ctx()
