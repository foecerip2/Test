"""Регрессия: пустые переменные окружения из compose не должны ронять запуск API."""

from __future__ import annotations

import pytest

from app.config import Settings


def test_empty_smtp_port_uses_default(monkeypatch: pytest.MonkeyPatch) -> None:
    # compose передаёт SMTP_PORT="" когда порт не настроен — раньше это падало с int_parsing.
    monkeypatch.setenv("SMTP_PORT", "")
    s = Settings()
    assert s.smtp_port == 465


def test_all_optional_mail_vars_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    for k in (
        "SMTP_HOST",
        "SMTP_PORT",
        "SMTP_USER",
        "SMTP_PASSWORD",
        "SMTP_FROM",
        "MAIL_RELAY_URL",
        "MAIL_RELAY_SECRET",
        "OWNER_EMAIL",
    ):
        monkeypatch.setenv(k, "")
    s = Settings()
    assert s.smtp_port == 465
    assert s.owner_email == ""
    assert s.smtp_host == ""


def test_real_value_still_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SMTP_PORT", "587")
    assert Settings().smtp_port == 587
