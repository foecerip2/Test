"""Pydantic-схемы запросов и ответов."""

from __future__ import annotations

import uuid
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, StringConstraints, field_validator


class EmailIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: EmailStr

    @field_validator("email", mode="before")
    @classmethod
    def _normalize(cls, v: object) -> object:
        if isinstance(v, str):
            v = v.strip().lower()
            if len(v) > 254:
                raise ValueError("слишком длинный email")
        return v


class OtpRequestOut(BaseModel):
    challenge_id: uuid.UUID
    expires_in: int
    resend_in: int


class OtpVerifyIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    challenge_id: uuid.UUID
    code: Annotated[str, StringConstraints(strip_whitespace=True, max_length=16)]


class OtpResendIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    challenge_id: uuid.UUID


class ResendOut(BaseModel):
    resend_in: int


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    role: Literal["owner", "user"]
    status: Literal["active", "pending", "blocked"]


class VerifyOut(BaseModel):
    user: UserOut
    is_new: bool


class MeOut(BaseModel):
    user: UserOut


class AdminUserOut(UserOut):
    created_at: str
    last_login_at: str | None = None


class UsersOut(BaseModel):
    users: list[AdminUserOut]


class AdminUserResult(BaseModel):
    user: AdminUserOut
