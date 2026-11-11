"""Конфигурация только из переменных окружения."""

from __future__ import annotations

from typing import Literal, Self
from urllib.parse import urlsplit

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEV_SECRET = "dev-insecure-secret-key-do-not-use-in-prod-0123456789"


class Settings(BaseSettings):
    # env_ignore_empty: пустая переменная окружения (например SMTP_PORT="" из compose)
    # считается «не заданной» и заменяется значением по умолчанию.
    model_config = SettingsConfigDict(
        env_file=None, extra="ignore", case_sensitive=False, env_ignore_empty=True
    )

    env: Literal["dev", "prod"] = "dev"
    database_url: str = "sqlite+pysqlite:///./leadhunter-dev.db"
    secret_key: str = DEV_SECRET
    public_origin: str = "http://localhost:3000"
    cookie_secure: bool | None = None
    trust_proxy_headers: bool | None = None
    owner_email: str = ""

    mail_backend: Literal["smtp", "console", "http"] = "console"
    smtp_host: str = ""
    smtp_port: int = 465
    smtp_user: str = ""
    smtp_password: str = Field(default="", repr=False)
    smtp_from: str = "LeadHunter <noreply@localhost>"
    smtp_security: Literal["ssl", "starttls", "none"] | None = None
    # HTTPS-ретранслятор (infra/mail-relay) — для серверов с закрытыми SMTP-портами.
    mail_relay_url: str = ""
    mail_relay_secret: str = Field(default="", repr=False)

    # Лимиты (менять не нужно; вынесены для тестов).
    otp_ttl_seconds: int = Field(default=600, ge=1)
    otp_resend_seconds: int = Field(default=60, ge=1)
    session_ttl_days: int = Field(default=30, ge=1)

    # Порог оценки «подходит для работы» (ТЗ §9, решение №14 плана): по умолчанию 75.
    score_threshold: int = Field(default=75, ge=0, le=100)

    # Срок хранения данных источника «CSV» (дни); показывается в /sources. Автоочистки пока нет.
    data_retention_days: int = Field(default=365, ge=1, le=3650)

    # Очередь задач и воркер (ADR-017): PostgreSQL, без Celery/Redis.
    worker_concurrency: int = Field(default=1, ge=1, le=2)
    worker_poll_seconds: float = Field(default=2.0, ge=0.05, le=60)
    job_lock_timeout_seconds: int = Field(default=300, ge=10)
    worker_heartbeat_file: str = "/tmp/lh-worker.heartbeat"  # noqa: S108

    # Только для тестов на localhost: отключает проверку адресов при загрузке сайтов (SSRF).
    allow_private_fetch_for_tests: bool = False

    @model_validator(mode="after")
    def _validate(self) -> Self:
        self.owner_email = self.owner_email.strip().lower()
        if self.database_url.startswith("postgres://"):
            self.database_url = "postgresql+psycopg://" + self.database_url[len("postgres://") :]
        elif self.database_url.startswith("postgresql://"):
            self.database_url = "postgresql+psycopg://" + self.database_url[len("postgresql://") :]
        self.public_origin = self.public_origin.strip().rstrip("/")
        if self.env == "prod":
            if len(self.secret_key) < 32 or self.secret_key == DEV_SECRET:
                raise ValueError("SECRET_KEY обязателен в prod и должен быть не короче 32 символов")
            if self.mail_backend == "console":
                raise ValueError("MAIL_BACKEND=console запрещён в prod, используйте http или smtp")
            if self.database_url.startswith("sqlite"):
                raise ValueError("В prod нужен PostgreSQL в DATABASE_URL")
        if self.allow_private_fetch_for_tests and self.env != "dev":
            raise ValueError("ALLOW_PRIVATE_FETCH_FOR_TESTS допустим только при ENV=dev")
        if len(self.secret_key) < 16:
            raise ValueError("SECRET_KEY слишком короткий")
        if self.mail_backend == "smtp" and not self.smtp_host:
            raise ValueError("Для MAIL_BACKEND=smtp задайте SMTP_HOST")
        self.mail_relay_url = self.mail_relay_url.strip()
        if self.mail_backend == "http":
            if not self.mail_relay_url:
                raise ValueError("Для MAIL_BACKEND=http задайте MAIL_RELAY_URL")
            parts = urlsplit(self.mail_relay_url)
            if parts.scheme not in ("https", "http") or not parts.hostname:
                raise ValueError("MAIL_RELAY_URL должен быть адресом https://...")
            if parts.username or parts.password or parts.fragment:
                raise ValueError("MAIL_RELAY_URL не должен содержать логин/пароль/фрагмент")
            if self.env == "prod" and parts.scheme != "https":
                raise ValueError("В prod MAIL_RELAY_URL должен начинаться с https://")
            if len(self.mail_relay_secret) < 32:
                raise ValueError("MAIL_RELAY_SECRET обязателен и должен быть не короче 32 символов")
        return self

    @property
    def cookie_secure_effective(self) -> bool:
        return self.env == "prod" if self.cookie_secure is None else self.cookie_secure

    @property
    def trust_proxy_effective(self) -> bool:
        return self.env == "prod" if self.trust_proxy_headers is None else self.trust_proxy_headers

    @property
    def smtp_security_effective(self) -> Literal["ssl", "starttls", "none"]:
        if self.smtp_security is not None:
            return self.smtp_security
        if self.smtp_port == 587:
            return "starttls"
        return "ssl"

    @property
    def public_origin_normalized(self) -> str:
        parts = urlsplit(self.public_origin)
        return f"{parts.scheme}://{parts.netloc}".lower()
