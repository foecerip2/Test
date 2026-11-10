"""Конфигурация из окружения. Секреты — только из env/secret-файлов, не из кода и не из git."""

from __future__ import annotations

import base64
import binascii
from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    environment: str = "production"
    database_url: str = "postgresql+psycopg://servermind:CHANGE_ME@localhost:5432/servermind"
    # base64 от 32 случайных байт. Обязателен, значения по умолчанию нет намеренно.
    encryption_master_key: str

    cookie_secure: bool = True
    session_idle_minutes: int = 720
    session_absolute_days: int = 7

    login_max_failures: int = 5
    login_window_minutes: int = 15

    # SSRF-политика: приватные/loopback/link-local цели разрешаются ТОЛЬКО явным флагом
    # (отдельное тестовое окружение администратора).
    allow_private_targets: bool = False

    ssh_connect_timeout: int = 10
    ssh_command_timeout: int = 15
    ssh_ops_per_minute: int = 10
    output_cap_bytes: int = 64 * 1024

    execution_enabled: bool = False  # kill switch для мутаций (Фаза 4); в Фазе 2 мутаций нет

    @field_validator("encryption_master_key")
    @classmethod
    def _key_must_be_32_bytes(cls, v: str) -> str:
        try:
            raw = base64.b64decode(v, validate=True)
        except (binascii.Error, ValueError) as e:
            raise ValueError("ENCRYPTION_MASTER_KEY должен быть base64") from e
        if len(raw) != 32:
            raise ValueError("ENCRYPTION_MASTER_KEY должен декодироваться ровно в 32 байта")
        return v

    @property
    def master_key_bytes(self) -> bytes:
        return base64.b64decode(self.encryption_master_key)


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
