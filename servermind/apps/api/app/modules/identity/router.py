from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends, Request, Response
from pydantic import Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.auth import (
    AuthContext,
    clear_session_cookie,
    client_ip,
    create_session,
    get_ctx,
    rotate_session,
    set_session_cookie,
    utcnow,
)
from app.core.config import get_settings
from app.core.permissions import ApiError
from app.core.security import (
    DUMMY_HASH,
    DecryptionError,
    decrypt,
    encrypt,
    new_totp_secret,
    totp_uri,
    verify_password,
    verify_totp,
)
from app.db.models import LoginAttempt, Membership, User, UserSession
from app.db.session import get_db
from app.modules.audit import service as audit
from app.modules.servers.schemas import CamelModel

router = APIRouter(tags=["identity"])
PRIVILEGED = {"owner", "operator"}  # для них 2FA обязательна (MD §1)


class LoginIn(CamelModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=256)


class LoginOut(CamelModel):
    two_factor_required: bool
    two_factor_setup_required: bool
    csrf_token: str


class CodeIn(CamelModel):
    code: str = Field(min_length=6, max_length=6)


class MeOut(CamelModel):
    id: str
    email: str
    name: str
    role: str
    workspace: str
    two_factor_enabled: bool
    stage: str
    csrf_token: str


class TotpSetupOut(CamelModel):
    secret: str
    otpauth_uri: str


def _aad(user_id: object) -> bytes:
    return f"totp:{user_id}".encode()


def _failures(db: Session, email: str, ip: str) -> int:
    s = get_settings()
    since = utcnow() - dt.timedelta(minutes=s.login_window_minutes)
    q = select(func.count()).select_from(LoginAttempt).where(
        LoginAttempt.success.is_(False), LoginAttempt.created_at >= since,
        (LoginAttempt.email == email) | (LoginAttempt.ip == ip))
    return db.scalar(q) or 0


def _role(db: Session, user: User) -> str | None:
    return db.scalar(select(Membership.role).where(Membership.user_id == user.id).order_by(Membership.created_at).limit(1))


@router.post("/auth/login", response_model=LoginOut)
def login(body: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)) -> LoginOut:
    s = get_settings()
    ip, email = client_ip(request), body.email.strip().lower()
    if _failures(db, email, ip) >= s.login_max_failures:
        audit.record(db, "auth.rate_limited", target=email, ip=ip)
        db.commit()
        raise ApiError(429, "rate_limited", "Слишком много неудачных попыток. Подождите и повторите позже.")
    user = db.scalar(select(User).where(User.email == email))
    ok = verify_password(user.password_hash if user else DUMMY_HASH, body.password) and user is not None and user.is_active
    db.add(LoginAttempt(email=email, ip=ip, success=bool(ok)))
    if not ok or user is None:
        audit.record(db, "auth.login_failed", target=email, ip=ip)
        db.commit()
        raise ApiError(401, "invalid_credentials", "Неверный email или пароль.")
    role = _role(db, user)
    if role is None:
        db.commit()
        raise ApiError(403, "forbidden", "Нет рабочего пространства.")
    stage = "pending_2fa" if user.totp_enabled else ("needs_2fa_setup" if role in PRIVILEGED else "active")
    token, row = create_session(db, user, stage, request)
    set_session_cookie(response, token)
    audit.record(db, "auth.login", actor_id=user.id, target=email, meta={"stage": stage}, ip=ip)
    db.commit()
    return LoginOut(two_factor_required=stage == "pending_2fa", two_factor_setup_required=stage == "needs_2fa_setup",
                    csrf_token=row.csrf_token)


@router.post("/auth/2fa", response_model=LoginOut)
def verify_2fa(body: CodeIn, request: Request, response: Response, ctx: AuthContext = Depends(get_ctx("pending_2fa")),
               db: Session = Depends(get_db)) -> LoginOut:
    s = get_settings()
    ip, email, user = client_ip(request), ctx.user.email, ctx.user
    if _failures(db, email, ip) >= s.login_max_failures:
        db.delete(ctx.session)
        db.commit()
        raise ApiError(429, "rate_limited", "Слишком много неудачных попыток. Войдите заново позже.")
    if user.totp_secret_enc is None:
        raise ApiError(409, "no_totp", "2FA не настроена.")
    try:
        secret = decrypt(s.master_key_bytes, user.totp_secret_enc, _aad(user.id)).decode()
    except DecryptionError:
        raise ApiError(500, "crypto", "Не удалось прочитать секрет 2FA.") from None
    step = verify_totp(secret, body.code, user.totp_last_step)
    if step is None:
        db.add(LoginAttempt(email=email, ip=ip, success=False))
        audit.record(db, "auth.2fa_failed", actor_id=user.id, org_id=ctx.org_id, ip=ip)
        db.commit()
        raise ApiError(401, "invalid_code", "Неверный код.")
    user.totp_last_step = step  # повторное использование этого кода невозможно
    row = rotate_session(db, ctx.session, user, "active", request, response)
    audit.record(db, "auth.2fa_ok", actor_id=user.id, org_id=ctx.org_id, ip=ip)
    db.commit()
    return LoginOut(two_factor_required=False, two_factor_setup_required=False, csrf_token=row.csrf_token)


@router.post("/auth/2fa/setup", response_model=TotpSetupOut)
def setup_2fa(ctx: AuthContext = Depends(get_ctx("needs_2fa_setup", "active")), db: Session = Depends(get_db)) -> TotpSetupOut:
    user = ctx.user
    if user.totp_enabled:
        raise ApiError(409, "already_enabled", "2FA уже включена.")
    secret = new_totp_secret()
    user.totp_secret_enc = encrypt(get_settings().master_key_bytes, secret.encode(), _aad(user.id))
    audit.record(db, "auth.2fa_setup_started", actor_id=user.id, org_id=ctx.org_id)
    db.commit()
    return TotpSetupOut(secret=secret, otpauth_uri=totp_uri(secret, user.email))  # показывается один раз


@router.post("/auth/2fa/enable", response_model=LoginOut)
def enable_2fa(body: CodeIn, request: Request, response: Response,
               ctx: AuthContext = Depends(get_ctx("needs_2fa_setup", "active")), db: Session = Depends(get_db)) -> LoginOut:
    user = ctx.user
    if user.totp_enabled or user.totp_secret_enc is None:
        raise ApiError(409, "bad_state", "Сначала запустите настройку 2FA.")
    try:
        secret = decrypt(get_settings().master_key_bytes, user.totp_secret_enc, _aad(user.id)).decode()
    except DecryptionError:
        raise ApiError(500, "crypto", "Не удалось прочитать секрет 2FA.") from None
    step = verify_totp(secret, body.code, user.totp_last_step)
    if step is None:
        raise ApiError(401, "invalid_code", "Неверный код.")
    user.totp_enabled, user.totp_last_step = True, step
    row = rotate_session(db, ctx.session, user, "active", request, response)
    audit.record(db, "auth.2fa_enabled", actor_id=user.id, org_id=ctx.org_id, ip=client_ip(request))
    db.commit()
    return LoginOut(two_factor_required=False, two_factor_setup_required=False, csrf_token=row.csrf_token)


@router.post("/auth/logout")
def logout(response: Response, ctx: AuthContext = Depends(get_ctx("pending_2fa", "needs_2fa_setup", "active")),
           db: Session = Depends(get_db)) -> dict[str, bool]:
    db.delete(ctx.session)
    audit.record(db, "auth.logout", actor_id=ctx.user.id, org_id=ctx.org_id)
    db.commit()
    clear_session_cookie(response)
    return {"ok": True}


@router.get("/me", response_model=MeOut)
def me(ctx: AuthContext = Depends(get_ctx("pending_2fa", "needs_2fa_setup", "active"))) -> MeOut:
    return MeOut(id=str(ctx.user.id), email=ctx.user.email, name=ctx.user.name or ctx.user.email, role=ctx.role,
                 workspace=ctx.org_name, two_factor_enabled=ctx.user.totp_enabled, stage=ctx.session.stage,
                 csrf_token=ctx.session.csrf_token)


__all__ = ["router", "UserSession"]
