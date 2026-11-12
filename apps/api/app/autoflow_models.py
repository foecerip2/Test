"""Данные AutoFlow. Каждый рабочий контур принадлежит администратору."""

from __future__ import annotations

import uuid
from datetime import date, datetime

import sqlalchemy as sa
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models import UTCDateTime, _now


class AutoFlowAccount(Base):
    __tablename__ = "af_accounts"
    user_id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, sa.ForeignKey("users.id"), primary_key=True)
    name: Mapped[str] = mapped_column(sa.String(80))
    business_name: Mapped[str] = mapped_column(sa.String(120))
    city: Mapped[str] = mapped_column(sa.String(80))
    consent_at: Mapped[datetime] = mapped_column(UTCDateTime, default=_now)


class Workspace(Base):
    __tablename__ = "af_workspaces"
    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, sa.ForeignKey("users.id"), unique=True)
    name: Mapped[str] = mapped_column(sa.String(120))
    city: Mapped[str] = mapped_column(sa.String(80))
    opens: Mapped[int] = mapped_column(sa.Integer, default=540)
    closes: Mapped[int] = mapped_column(sa.Integer, default=1140)


class Service(Base):
    __tablename__ = "af_services"
    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=uuid.uuid4)
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("af_workspaces.id"), index=True
    )
    name: Mapped[str] = mapped_column(sa.String(120))
    duration: Mapped[int] = mapped_column(sa.Integer)
    price: Mapped[int] = mapped_column(
        sa.Integer, default=0
    )  # рубли; услуги не оплачиваются онлайн


class Resource(Base):
    __tablename__ = "af_resources"
    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=uuid.uuid4)
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("af_workspaces.id"), index=True
    )
    name: Mapped[str] = mapped_column(sa.String(80))


class Appointment(Base):
    __tablename__ = "af_appointments"
    __table_args__ = (
        sa.CheckConstraint(
            "status IN ('new','confirmed','completed','cancelled')", name="ck_af_appointment_status"
        ),
        sa.CheckConstraint("ends > starts", name="ck_af_appointment_duration"),
        sa.Index("ix_af_appointment_resource_day", "resource_id", "day"),
    )
    id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, primary_key=True, default=uuid.uuid4)
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        sa.Uuid, sa.ForeignKey("af_workspaces.id"), index=True
    )
    service_id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, sa.ForeignKey("af_services.id"))
    resource_id: Mapped[uuid.UUID] = mapped_column(sa.Uuid, sa.ForeignKey("af_resources.id"))
    day: Mapped[date] = mapped_column(sa.Date)
    starts: Mapped[int] = mapped_column(sa.Integer)
    ends: Mapped[int] = mapped_column(sa.Integer)
    customer: Mapped[str] = mapped_column(sa.String(80))
    phone: Mapped[str] = mapped_column(sa.String(16))
    note: Mapped[str] = mapped_column(sa.String(1000), default="")
    status: Mapped[str] = mapped_column(sa.String(16), default="new")
    consent_at: Mapped[datetime] = mapped_column(UTCDateTime, default=_now)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=_now)
