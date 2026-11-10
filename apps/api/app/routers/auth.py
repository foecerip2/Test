"""Регистрация и вход по email + одноразовому коду."""

from __future__ import annotations

import logging
import math
import uuid
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import security
from app.config import Settings
from app.db import get_db
from app.deps import (
    CSRF_COOKIE,
    SESSION_COOKIE,
    AuthContext,
    client_ip,
    get_auth,
    get_mailer,
    get_settings,
    require_csrf,
)
from app.mail import Mailer, MailError, render_otp_email
from app.models import AuditLog, OtpChallenge, RateLimitEvent, SessionRow, User
from app.schemas import (
    EmailIn,
    MeOut,
    OtpRequestOut,
    OtpResendIn,
    OtpVerifyIn,
    ResendOut,
    UserOut,
    VerifyOut,
)
from app.security import AppError

log = logging.getLogger("leadhunter.auth")

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])

MAX_ATTEMPTS = 5
MAX_SENDS = 5
EMAIL_PER_HOUR = 5
IP_PER_HOUR = 20
HOUR = timedelta(hours=1)


def _rate_limited(seconds: float) -> AppError:
    retry = max(1, math.ceil(seconds))
    return AppError(
        429,
        "RATE_LIMITED",
        "Слишком много запросов. Повторите позже.",
        headers={"Retry-After": str(retry)},
    )


def _events(db: Session, scope: str, key: str, since: datetime) -> list[datetime]:
    rows = db.scalars(
        select(RateLimitEvent.created_at)
        .where(
            RateLimitEvent.scope == scope,
            RateLimitEvent.key == key,
            RateLimitEvent.created_at > since,
        )
        .order_by(RateLimitEvent.created_at)
    )
    return list(rows)


def enforce_send_limits(db: Session, settings: Settings, email: str, ip: str) -> list[uuid.UUID]:
    """Лимиты отправки кода (в БД). Записывает события, возвращает их id (для отката)."""
    n = security.now()
    ek = security.keyed_hash(settings, "email", email)
    ik = security.keyed_hash(settings, "ip", ip)

    ip_events = _events(db, "otp_ip", ik, n - HOUR)
    if len(ip_events) >= IP_PER_HOUR:
        raise _rate_limited((ip_events[0] + HOUR - n).total_seconds())

    email_events = _events(db, "otp_email", ek, n - HOUR)
    if email_events:
        since_last = (n - email_events[-1]).total_seconds()
        if since_last < settings.otp_resend_seconds:
            raise _rate_limited(settings.otp_resend_seconds - since_last)
    if len(email_events) >= EMAIL_PER_HOUR:
        raise _rate_limited((email_events[0] + HOUR - n).total_seconds())

    db.execute(delete(RateLimitEvent).where(RateLimitEvent.created_at < n - 2 * HOUR))
    ids: list[uuid.UUID] = []
    for scope, key in (("otp_email", ek), ("otp_ip", ik)):
        ev = RateLimitEvent(id=uuid.uuid4(), scope=scope, key=key, created_at=n)
        db.add(ev)
        ids.append(ev.id)
    db.commit()
    return ids


def _audit(
    db: Session,
    action: str,
    actor_id: uuid.UUID | None = None,
    entity: str | None = None,
    entity_id: str | None = None,
    meta: dict[str, object] | None = None,
) -> None:
    db.add(
        AuditLog(actor_id=actor_id, action=action, entity=entity, entity_id=entity_id, meta=meta)
    )


def _send_code(mailer: Mailer, email: str, code: str, ttl_seconds: int) -> None:
    subject, text, html_body = render_otp_email(code, ttl_seconds // 60)
    try:
        mailer.send(email, subject, text, html_body)
    except MailError as exc:
        raise AppError(
            503, "MAIL_UNAVAILABLE", "Не удалось отправить письмо. Попробуйте позже."
        ) from exc


@router.post("/otp/request", response_model=OtpRequestOut, status_code=202)
def otp_request(
    body: EmailIn,
    request: Request,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
    mailer: Mailer = Depends(get_mailer),
) -> OtpRequestOut:
    email = str(body.email)
    ip = client_ip(request, settings)
    rate_ids = enforce_send_limits(db, settings, email, ip)

    user = db.scalar(select(User).where(User.email == email))
    if user is None:
        user = User(email=email, role="user", status="pending")
        db.add(user)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            user = db.scalar(select(User).where(User.email == email))
            if user is None:
                raise
    n = security.now()
    challenge_id = uuid.uuid4()
    code = security.generate_code()
    db.add(
        OtpChallenge(
            id=challenge_id,
            user_id=user.id,
            email=email,
            code_hmac=security.code_hmac(settings, challenge_id, code),
            expires_at=n + timedelta(seconds=settings.otp_ttl_seconds),
            attempts=0,
            sends=1,
            last_sent_at=n,
            ip_hash=security.keyed_hash(settings, "ip", ip),
        )
    )
    db.commit()

    try:
        _send_code(mailer, email, code, settings.otp_ttl_seconds)
    except AppError:
        # Код не считается выданным: откатываем challenge и cooldown.
        db.execute(delete(OtpChallenge).where(OtpChallenge.id == challenge_id))
        db.execute(delete(RateLimitEvent).where(RateLimitEvent.id.in_(rate_ids)))
        db.commit()
        raise

    _audit(
        db,
        "otp.request",
        entity="otp_challenge",
        entity_id=str(challenge_id),
        meta={"email": security.mask_email(email)},
    )
    db.commit()
    return OtpRequestOut(
        challenge_id=challenge_id,
        expires_in=settings.otp_ttl_seconds,
        resend_in=settings.otp_resend_seconds,
    )


@router.post("/otp/resend", response_model=ResendOut, status_code=202)
def otp_resend(
    body: OtpResendIn,
    request: Request,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
    mailer: Mailer = Depends(get_mailer),
) -> ResendOut:
    ch = db.scalar(
        select(OtpChallenge).where(OtpChallenge.id == body.challenge_id).with_for_update()
    )
    gone = AppError(410, "CODE_EXPIRED", "Код недействителен. Запросите новый код.")
    n = security.now()
    if ch is None or ch.consumed_at is not None or ch.expires_at <= n:
        raise gone
    if ch.attempts >= MAX_ATTEMPTS:
        raise AppError(
            429, "TOO_MANY_ATTEMPTS", "Слишком много неверных попыток. Запросите новый код."
        )
    if ch.sends >= MAX_SENDS:
        raise _rate_limited(settings.otp_resend_seconds)
    since_last = (n - ch.last_sent_at).total_seconds()
    if since_last < settings.otp_resend_seconds:
        raise _rate_limited(settings.otp_resend_seconds - since_last)

    ip = client_ip(request, settings)
    rate_ids = enforce_send_limits(db, settings, ch.email, ip)

    code = security.generate_code()
    old = (ch.code_hmac, ch.expires_at, ch.last_sent_at, ch.sends)
    ch.code_hmac = security.code_hmac(settings, ch.id, code)
    ch.expires_at = n + timedelta(seconds=settings.otp_ttl_seconds)
    ch.last_sent_at = n
    ch.sends += 1
    db.commit()

    try:
        _send_code(mailer, ch.email, code, settings.otp_ttl_seconds)
    except AppError:
        ch.code_hmac, ch.expires_at, ch.last_sent_at, ch.sends = old
        db.execute(delete(RateLimitEvent).where(RateLimitEvent.id.in_(rate_ids)))
        db.commit()
        raise
    _audit(db, "otp.resend", entity="otp_challenge", entity_id=str(ch.id))
    db.commit()
    return ResendOut(resend_in=settings.otp_resend_seconds)


def _set_cookies(response: Response, settings: Settings, token: str) -> None:
    max_age = settings.session_ttl_days * 86400
    secure = settings.cookie_secure_effective
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=max_age,
        httponly=True,
        secure=secure,
        samesite="lax",
        path="/",
    )
    response.set_cookie(
        CSRF_COOKIE,
        security.csrf_for_session(settings, token),
        max_age=max_age,
        httponly=False,
        secure=secure,
        samesite="lax",
        path="/",
    )


@router.post("/otp/verify", response_model=VerifyOut)
def otp_verify(
    body: OtpVerifyIn,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> VerifyOut:
    ch = db.scalar(
        select(OtpChallenge).where(OtpChallenge.id == body.challenge_id).with_for_update()
    )
    n = security.now()
    if ch is None:
        raise AppError(410, "CODE_EXPIRED", "Код недействителен. Запросите новый код.")
    if ch.consumed_at is not None:
        raise AppError(410, "CODE_USED", "Код уже использован. Запросите новый код.")
    if ch.expires_at <= n:
        raise AppError(410, "CODE_EXPIRED", "Срок действия кода истёк. Запросите новый код.")
    if ch.attempts >= MAX_ATTEMPTS:
        raise AppError(
            429, "TOO_MANY_ATTEMPTS", "Слишком много неверных попыток. Запросите новый код."
        )

    candidate = body.code if body.code.isascii() and body.code.isdigit() else ""
    if not security.verify_code(settings, ch.id, candidate, ch.code_hmac):
        ch.attempts += 1
        left = max(0, MAX_ATTEMPTS - ch.attempts)
        _audit(db, "otp.verify_failed", entity="otp_challenge", entity_id=str(ch.id))
        db.commit()
        raise AppError(
            400,
            "INVALID_CODE",
            "Неверный код.",
            extra={"attempts_left": left},
        )

    user = db.get(User, ch.user_id)
    if user is None:
        raise AppError(410, "CODE_EXPIRED", "Код недействителен. Запросите новый код.")
    if user.status == "blocked":
        raise AppError(403, "ACCOUNT_BLOCKED", "Аккаунт заблокирован.")

    # Атомарное «одноразовое» использование.
    res = db.execute(
        update(OtpChallenge)
        .where(OtpChallenge.id == ch.id, OtpChallenge.consumed_at.is_(None))
        .values(consumed_at=n)
    )
    if res.rowcount != 1:  # type: ignore[attr-defined]
        db.rollback()
        raise AppError(410, "CODE_USED", "Код уже использован. Запросите новый код.")

    is_new = user.last_login_at is None
    if is_new and settings.owner_email and user.email == settings.owner_email:
        user.role = "owner"
        user.status = "active"
    user.last_login_at = n

    token = security.new_session_token()
    db.add(
        SessionRow(
            user_id=user.id,
            token_hash=security.session_token_hash(settings, token),
            expires_at=n + timedelta(days=settings.session_ttl_days),
            ip_hash=security.keyed_hash(settings, "ip", client_ip(request, settings)),
            user_agent=(request.headers.get("user-agent") or "")[:256] or None,
        )
    )
    _audit(
        db,
        "auth.login",
        actor_id=user.id,
        entity="user",
        entity_id=str(user.id),
        meta={"is_new": is_new},
    )
    db.commit()
    _set_cookies(response, settings, token)
    return VerifyOut(user=UserOut.model_validate(user), is_new=is_new)


@router.get("/me", response_model=MeOut)
def me(
    request: Request,
    response: Response,
    auth: AuthContext = Depends(get_auth),
    settings: Settings = Depends(get_settings),
) -> MeOut:
    expected = security.csrf_for_session(settings, auth.token)
    if request.cookies.get(CSRF_COOKIE) != expected:
        response.set_cookie(
            CSRF_COOKIE,
            expected,
            max_age=settings.session_ttl_days * 86400,
            httponly=False,
            secure=settings.cookie_secure_effective,
            samesite="lax",
            path="/",
        )
    return MeOut(user=UserOut.model_validate(auth.user))


@router.post("/logout", status_code=204)
def logout(
    db: Session = Depends(get_db),
    auth: AuthContext = Depends(require_csrf),
    settings: Settings = Depends(get_settings),
) -> Response:
    auth.session.revoked_at = security.now()
    _audit(
        db, "auth.logout", actor_id=auth.user.id, entity="session", entity_id=str(auth.session.id)
    )
    db.commit()
    resp = Response(status_code=204)
    secure = settings.cookie_secure_effective
    resp.delete_cookie(SESSION_COOKIE, path="/", secure=secure, httponly=True, samesite="lax")
    resp.delete_cookie(CSRF_COOKIE, path="/", secure=secure, samesite="lax")
    return resp
