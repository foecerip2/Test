"""Строгие контракты закрытого приложения AutoFlow."""

from __future__ import annotations

import uuid
from datetime import date
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator, model_validator

from app.pilot_schemas import clean_text, normalize_phone_ru


class TextIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    @field_validator("*", mode="before")
    @classmethod
    def clean(cls, value: object) -> object:
        return clean_text(value) if isinstance(value, str) else value


class AccountIn(TextIn):
    name: str = Field(min_length=1, max_length=80)
    business_name: str = Field(min_length=1, max_length=120)
    city: str = Field(min_length=1, max_length=80)
    consent: StrictBool

    @field_validator("consent")
    @classmethod
    def agree(cls, value: bool) -> bool:
        if not value:
            raise ValueError("Необходимо согласие")
        return value


class WorkspaceIn(TextIn):
    name: str = Field(min_length=1, max_length=120)
    city: str = Field(min_length=1, max_length=80)
    opens: int = Field(default=540, ge=0, le=1380, strict=True)
    closes: int = Field(default=1140, ge=60, le=1440, strict=True)

    @model_validator(mode="after")
    def interval(self) -> Self:
        if self.opens >= self.closes or self.opens % 15 or self.closes % 15:
            raise ValueError("Неверные рабочие часы")
        return self


class ServiceIn(TextIn):
    name: str = Field(min_length=1, max_length=120)
    duration: int = Field(ge=15, le=480, strict=True)
    price: int = Field(default=0, ge=0, le=1000000, strict=True)

    @field_validator("duration")
    @classmethod
    def quarter(cls, value: int) -> int:
        if value % 15:
            raise ValueError("Продолжительность кратна 15 минутам")
        return value


class ResourceIn(TextIn):
    name: str = Field(min_length=1, max_length=80)


class AppointmentIn(TextIn):
    service_id: uuid.UUID
    resource_id: uuid.UUID
    day: date
    starts: int = Field(ge=0, lt=1440, strict=True)
    customer: str = Field(min_length=1, max_length=80)
    phone: str = Field(max_length=32)
    note: str = Field(default="", max_length=1000)
    consent: StrictBool

    @field_validator("phone")
    @classmethod
    def phone_ru(cls, value: str) -> str:
        return normalize_phone_ru(value)

    @field_validator("consent")
    @classmethod
    def agree(cls, value: bool) -> bool:
        if not value:
            raise ValueError("Необходимо основание для обработки данных")
        return value


AppointmentStatus = Literal["new", "confirmed", "completed", "cancelled"]


class AppointmentPatch(TextIn):
    status: AppointmentStatus
