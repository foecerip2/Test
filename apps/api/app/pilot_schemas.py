"""Схемы и нормализация для заявок на пилот AutoFlow (публичная форма и кабинет владельца)."""

from __future__ import annotations

import re
import unicodedata
import uuid
from typing import Annotated, Literal, Self

from pydantic import (
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    StrictBool,
    StrictStr,
    TypeAdapter,
    ValidationInfo,
    field_validator,
    model_validator,
)

PilotStatus = Literal["new", "contacted", "accepted", "declined", "spam"]

_PHONE_ALLOWED = re.compile(r"^\+?[\d\s().\-]+$")
_URLISH = re.compile(r"(://|www\.|\bt\.me/|@\w+\.\w)", re.IGNORECASE)
_HAS_LETTER_OR_DIGIT = re.compile(r"[^\W_]", re.UNICODE)
_EMAIL = TypeAdapter(EmailStr)
_LIMITS = {"business_name": 120, "city": 80, "contact_name": 80}
# Коды РФ (+7): 3xx, 4xx, 8xx — города/регионы, 9xx — мобильные.
_RU_FIRST = "3489"


def clean_text(value: str, *, multiline: bool = False) -> str:
    """NFC, схлопывание пробелов; управляющие, bidi- и «невидимые» символы → ошибка."""
    text = unicodedata.normalize("NFC", value)
    if not multiline:
        text = "".join(" " if ch.isspace() else ch for ch in text)  # \t, \n, nbsp → пробел
    for ch in text:
        if multiline and ch in "\n\r\t":
            continue
        if unicodedata.category(ch) in ("Cc", "Cf", "Cs", "Co", "Cn", "Zl", "Zp"):
            raise ValueError("недопустимые символы")
    if multiline:
        lines = [" ".join(line.split()) for line in text.replace("\r\n", "\n").split("\n")]
        return "\n".join(lines).strip()
    return " ".join(text.split())


def normalize_phone_ru(raw: str) -> str:
    """Российский номер → +7XXXXXXXXXX. Допускаются пробелы, скобки, дефисы, точки."""
    value = raw.strip()
    if not value or len(value) > 32 or not _PHONE_ALLOWED.match(value):
        raise ValueError("телефон")
    if "+" in value[1:]:
        raise ValueError("телефон")
    digits = re.sub(r"\D", "", value)
    if len(digits) == 11 and digits[0] in "78":
        national = digits[1:]
    elif len(digits) == 10 and not value.startswith("+"):
        national = digits
    else:
        raise ValueError("телефон")
    if national[0] not in _RU_FIRST or len(set(national)) == 1:
        raise ValueError("телефон")
    return f"+7{national}"


class PilotRequestIn(BaseModel):
    """Тело публичного POST. Лишние поля игнорируются (форма может слать служебные)."""

    model_config = ConfigDict(extra="ignore")

    business_name: StrictStr
    city: StrictStr
    contact_name: StrictStr
    phone: StrictStr | None = None
    email: StrictStr | None = None
    consent: StrictBool
    website: StrictStr | None = ""  # honeypot: у людей пусто (непустое отсекает роутер)
    consent_text_version: StrictStr | None = None

    @field_validator("business_name", "city", "contact_name", mode="after")
    @classmethod
    def _clean(cls, v: str, info: ValidationInfo) -> str:
        limit = _LIMITS[info.field_name or ""]
        if len(v) > limit * 4:  # грубая защита до очистки
            raise ValueError("слишком длинно")
        text = clean_text(v)
        if not text or len(text) > limit:
            raise ValueError("длина")
        if not _HAS_LETTER_OR_DIGIT.search(text) or "<" in text or ">" in text:
            raise ValueError("содержимое")
        if info.field_name in ("city", "contact_name") and _URLISH.search(text):
            raise ValueError("ссылки не допускаются")
        return text

    @field_validator("phone", mode="after")
    @classmethod
    def _phone(cls, v: str | None) -> str | None:
        if v is None or not v.strip():
            return None
        return normalize_phone_ru(v)

    @field_validator("email", mode="after")
    @classmethod
    def _email(cls, v: str | None) -> str | None:
        if v is None or not v.strip():
            return None
        v = v.strip().lower()
        if len(v) > 254 or any(c.isspace() for c in v):
            raise ValueError("email")
        return str(_EMAIL.validate_python(v)).lower()

    @field_validator("consent", mode="after")
    @classmethod
    def _consent(cls, v: bool) -> bool:
        if v is not True:
            raise ValueError("нужно согласие")
        return v

    @field_validator("consent_text_version", mode="after")
    @classmethod
    def _version(cls, v: str | None) -> str | None:
        if v is None or not v.strip():
            return None
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,32}", v.strip()):
            raise ValueError("версия")
        return v.strip()

    @model_validator(mode="after")
    def _need_contact(self) -> Self:
        if self.phone is None and self.email is None:
            raise ValueError("нужен телефон или e-mail")
        return self


class PilotAccepted(BaseModel):
    status: Literal["accepted"] = "accepted"


class PilotRequestOut(BaseModel):
    id: uuid.UUID
    business_name: str
    city: str
    contact_name: str
    phone: str | None
    email: str | None
    status: PilotStatus
    note: str
    consent_at: str
    consent_text_version: str
    created_at: str
    updated_at: str


class PilotRequestsOut(BaseModel):
    items: list[PilotRequestOut]
    next_cursor: str | None


NoteStr = Annotated[StrictStr, Field(max_length=2000)]


class PilotRequestPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: PilotStatus | None = None
    note: NoteStr | None = None

    @field_validator("note", mode="after")
    @classmethod
    def _note(cls, v: str | None) -> str | None:
        return None if v is None else clean_text(v, multiline=True)

    @model_validator(mode="after")
    def _not_empty(self) -> Self:
        if self.status is None and self.note is None:
            raise ValueError("нет изменений")
        return self
