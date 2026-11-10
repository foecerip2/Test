"""Каталог одобренных операций. Это ЕДИНСТВЕННЫЙ список того, что вообще может оказаться в плане.
Параметры строго типизированы (extra=forbid), произвольной shell-команды в каталоге нет и быть не может.
R0–R3 допустимы (R2/R3 — только после явного подтверждения человеком); R4/R5 в MVP запрещены."""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

RISK_ORDER = ["R0", "R1", "R2", "R3", "R4", "R5"]
MAX_ALLOWED_RISK = "R3"

IMAGE_RE = re.compile(r"^[a-z0-9][a-z0-9._/-]{0,127}(:[A-Za-z0-9._-]{1,64}|@sha256:[0-9a-f]{64})$")
UNIT_RE = re.compile(r"^[a-z0-9][a-z0-9@._-]{0,63}$")
ENV_KEY_RE = re.compile(r"^[A-Z_][A-Z0-9_]{0,63}$")
HOSTNAME_RE = re.compile(r"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
LOCAL_URL_RE = re.compile(r"^http://127\.0\.0\.1:\d{2,5}(/[A-Za-z0-9._~\-/]*)?$")


class Params(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class DockerInstallParams(Params):
    channel: Literal["stable"] = "stable"
    add_user_to_docker_group: Literal[False] = False  # членство в группе docker = root, поэтому запрещено


class DeployComposeParams(Params):
    template: Literal["web-app"]  # только заранее проверенный шаблон; произвольный compose/Dockerfile невозможен
    image: str
    port: int = Field(ge=1024, le=65535)
    env_keys: list[str] = Field(default_factory=list, max_length=20)  # только ИМЕНА; значения в план не попадают
    read_only_rootfs: Literal[True] = True
    privileged: Literal[False] = False

    @field_validator("image")
    @classmethod
    def _image(cls, v: str) -> str:
        if not IMAGE_RE.fullmatch(v) or v.endswith(":latest"):
            raise ValueError("image")
        return v

    @field_validator("env_keys")
    @classmethod
    def _env(cls, v: list[str]) -> list[str]:
        if len(set(v)) != len(v) or not all(ENV_KEY_RE.fullmatch(k) for k in v):
            raise ValueError("env_keys")
        return v


class ServiceRestartParams(Params):
    unit: str

    @field_validator("unit")
    @classmethod
    def _unit(cls, v: str) -> str:
        if not UNIT_RE.fullmatch(v):
            raise ValueError("unit")
        return v


class HttpHealthcheckParams(Params):
    url: str  # только localhost самого сервера: инструмент не может ходить по сети
    expect_status: int = Field(default=200, ge=100, le=599)
    timeout_s: int = Field(default=10, ge=1, le=30)

    @field_validator("url")
    @classmethod
    def _url(cls, v: str) -> str:
        if not LOCAL_URL_RE.fullmatch(v):
            raise ValueError("url")
        return v


class DomainHttpsParams(Params):
    domain: str

    @field_validator("domain")
    @classmethod
    def _d(cls, v: str) -> str:
        if not HOSTNAME_RE.fullmatch(v):
            raise ValueError("domain")
        return v


@dataclass(frozen=True)
class ToolSpec:
    name: str
    risk: str
    mutating: bool
    params_model: type[Params]
    title: Callable[[dict[str, Any]], str]
    expected_change: Callable[[dict[str, Any]], str]
    verify: Callable[[dict[str, Any]], str]
    rollback: Callable[[dict[str, Any]], str]
    optional: bool = False
    enabled: bool = True


CATALOG: dict[str, ToolSpec] = {
    "docker.install": ToolSpec(
        "docker.install", "R3", True, DockerInstallParams,
        lambda p: "Установить Docker Engine и Compose-плагин",
        lambda p: "Добавится apt-репозиторий Docker, будут установлены пакеты docker-ce и docker-compose-plugin; запустится служба docker.",
        lambda p: "docker --version; systemctl is-active docker",
        lambda p: "Автоматического отката нет: пакеты удаляются вручную (apt remove).",
    ),
    "app.deploy_compose": ToolSpec(
        "app.deploy_compose", "R3", True, DeployComposeParams,
        lambda p: f"Запустить шаблон «{p['template']}» из образа {p['image']}",
        lambda p: "Создаётся проект Compose из проверенного шаблона; контейнер слушает 127.0.0.1. Значения переменных окружения в план не попадают.",
        lambda p: "docker compose ps — контейнер running (healthy)",
        lambda p: "docker compose down — данные тома сохраняются.",
    ),
    "service.restart": ToolSpec(
        "service.restart", "R2", True, ServiceRestartParams,
        lambda p: f"Перезапустить службу {p['unit']}",
        lambda p: f"Служба {p['unit']} будет остановлена и запущена заново; возможен короткий простой.",
        lambda p: f"systemctl is-active {p['unit']}",
        lambda p: "Откат не требуется: повторный перезапуск безопасен.",
    ),
    "http.healthcheck": ToolSpec(
        "http.healthcheck", "R1", False, HttpHealthcheckParams,
        lambda p: f"Проверить ответ {p['url']}",
        lambda p: "Изменений нет — только чтение.",
        lambda p: f"HTTP {p['expect_status']} за {p['timeout_s']} с",
        lambda p: "Не требуется.",
        optional=True,
    ),
    # Выключено: требует DNS preflight и security review (Фаза 4). Остаётся «manual only».
    "domain.configure_https": ToolSpec(
        "domain.configure_https", "R3", True, DomainHttpsParams,
        lambda p: f"Настроить HTTPS для {p['domain']}", lambda p: "", lambda p: "", lambda p: "", enabled=False,
    ),
}

# Инструменты чтения, доступные модели. Они читают ТОЛЬКО уже сохранённые проверенные данные, ничего не запускают.
READ_TOOLS: dict[str, str] = {
    "server.facts": "Факты о выбранном сервере: ОС, uptime, время последней проверки, статус.",
    "server.metrics": "Последние измерения CPU/RAM/диска выбранного сервера (до 24 точек, с метками времени UTC).",
    "service.status": "Состояние известных служб выбранного сервера (active/inactive/failed).",
}


def risk_rank(r: str) -> int:
    return RISK_ORDER.index(r)
