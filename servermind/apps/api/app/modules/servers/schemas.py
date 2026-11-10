from __future__ import annotations

import datetime as dt
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, from_attributes=True)


class ProbeIn(CamelModel):
    host: str = Field(min_length=1, max_length=253)
    port: int = 22


class ProbeOut(CamelModel):
    fingerprint: str
    key_type: str
    source: Literal["ssh"] = "ssh"


class AddServerIn(CamelModel):
    name: str = Field(default="", max_length=120)
    host: str = Field(min_length=1, max_length=253)
    port: int = 22
    username: str = Field(min_length=1, max_length=32)
    fingerprint: str = Field(min_length=10, max_length=80)


class ServiceOut(CamelModel):
    name: str
    state: Literal["active", "inactive", "failed", "unknown"]
    managed: bool = False


class ServerOut(CamelModel):
    id: str
    name: str
    host: str
    port: int
    username: str
    os: str | None
    status: Literal["online", "offline", "checking", "unknown"]
    last_checked_at: dt.datetime | None
    last_success_at: dt.datetime | None
    uptime_seconds: int | None
    cpu_percent: float | None
    ram_used_mb: int | None
    ram_total_mb: int | None
    disk_used_gb: float | None
    disk_total_gb: float | None
    fingerprint: str
    services: list[ServiceOut]
    source: Literal["ssh"] = "ssh"


class VerifyOut(CamelModel):
    os: str
    server: ServerOut


class PublicKeyOut(CamelModel):
    key: str
    source: Literal["ssh"] = "ssh"


class MetricPoint(CamelModel):
    t: dt.datetime
    cpu: float
    ram: float
    disk: float


class MetricsOut(CamelModel):
    samples: list[MetricPoint]
    interval_sec: int  # 0 — периодический опрос ещё не настроен (Фаза 5); точки появляются при ручной проверке
    source: Literal["ssh"] = "ssh"
