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

    worker_enabled: bool = True  # фоновый воркер; в режиме репетиции работает только с БД, на серверы не ходит
    worker_poll_seconds: int = 3
    execution_enabled: bool = False  # kill switch для мутаций (Фаза 4); в Фазах 2–3 ничего не исполняется

    # --- Фаза 3: AI и планы ---
    plan_ttl_minutes: int = 15
    managed_services: list[str] = ["nginx"]  # службы, которые разрешено перезапускать через service.restart
    allowed_image_prefixes: list[str] = ["registry.servermind.example/"]  # реестры образов для app.deploy_compose
    ai_requests_per_hour: int = 60
    ai_history_messages: int = 12
    ai_max_context_chars: int = 12000
    ai_max_output_tokens: int = 1024
    ai_timeout_seconds: int = 60
    ai_max_iterations: int = 4

    # --- Фаза 5: кредиты (режим ServerMind Credits). Цены НЕ выдуманы: их задаёт оператор платформы; пока не заданы — режим недоступен ---
    platform_admin_emails: list[str] = []         # кто может выдавать кредиты и читать общий аудит (JSON-список в env)
    platform_ai_provider: str = ""                # openai | anthropic | deepseek
    platform_ai_model: str = ""
    platform_ai_key: str = ""                     # ключ платформы: только из окружения, в БД и логи не попадает
    price_in_per_1k: int = 0                      # кредитов (минимальных единиц) за 1000 входных токенов
    price_out_per_1k: int = 0                     # кредитов за 1000 выходных токенов
    price_list_version: str = ""                  # версия прайс-листа провайдера, записывается в проводку
    credits_daily_cap: int | None = None          # лимит списаний организации за 24 ч (None — без лимита)
    credits_monthly_cap: int | None = None        # лимит за 30 суток
    stale_reservation_minutes: int = 10           # резерв без списания старше этого срока освобождается воркером

    @property
    def platform_ai_configured(self) -> bool:
        return (self.platform_ai_provider in ("openai", "anthropic", "deepseek") and bool(self.platform_ai_model)
                and bool(self.platform_ai_key) and self.price_in_per_1k > 0 and self.price_out_per_1k > 0)

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
